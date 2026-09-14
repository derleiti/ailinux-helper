#!/usr/bin/env python3
"""Long-lived XDG RemoteDesktop input bridge for AILinux Helper.

JSON lines on stdin -> JSON lines on stdout.  The XDG portal owns the actual
permission prompt and session; the helper never opens /dev/uinput directly.
"""
import json
import os
import sys
import time
import uuid

try:
    import dbus
    import dbus.mainloop.glib
    from gi.repository import GLib
except Exception as exc:
    print(json.dumps({"ready": False, "error": f"dbus/gi unavailable: {exc}"}), flush=True)
    raise SystemExit(3)

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
BUS_NAME = "org.freedesktop.portal.Desktop"
OBJ_PATH = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.RemoteDesktop"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
DEVICE_KEYBOARD = 1
DEVICE_POINTER = 2
STATE_RELEASED = 0
STATE_PRESSED = 1
BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}
KEYSYM = {
    "enter": 0xFF0D, "return": 0xFF0D, "escape": 0xFF1B, "esc": 0xFF1B,
    "tab": 0xFF09, "space": 0x20, "backspace": 0xFF08, "delete": 0xFFFF,
    "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54,
    "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55, "pagedown": 0xFF56,
}

bus = dbus.SessionBus()
portal_obj = bus.get_object(BUS_NAME, OBJ_PATH)
portal = dbus.Interface(portal_obj, IFACE)
session_handle = None


def token(prefix):
    return f"ailinux_{prefix}_{uuid.uuid4().hex[:16]}"


def request_call(method, args, options, timeout=90):
    """Call an XDG portal request and synchronously await its Response signal."""
    holder = {"done": False, "response": 2, "results": {}, "path": None}
    loop = GLib.MainLoop()

    def on_response(response, results, path=None):
        if holder["path"] and path and str(path) != holder["path"]:
            return
        holder["done"] = True
        holder["response"] = int(response)
        holder["results"] = dict(results)
        if loop.is_running():
            loop.quit()

    receiver = bus.add_signal_receiver(
        on_response,
        signal_name="Response",
        dbus_interface=REQUEST_IFACE,
        bus_name=BUS_NAME,
        path_keyword="path",
    )
    try:
        req = method(*args, options)
        holder["path"] = str(req)
        if not holder["done"]:
            timer = GLib.timeout_add_seconds(timeout, lambda: (loop.quit(), False)[1])
            loop.run()
            try:
                GLib.source_remove(timer)
            except Exception:
                pass
        if not holder["done"]:
            raise TimeoutError("portal request timed out")
        if holder["response"] != 0:
            raise PermissionError(f"portal request rejected: response={holder['response']}")
        return holder["results"]
    finally:
        try:
            receiver.remove()
        except Exception:
            pass


def ensure_session():
    global session_handle
    if session_handle:
        return session_handle
    result = request_call(
        portal.CreateSession,
        (),
        dbus.Dictionary({
            "handle_token": dbus.String(token("create")),
            "session_handle_token": dbus.String(token("session")),
        }, signature="sv"),
        timeout=15,
    )
    handle = result.get("session_handle")
    if not handle:
        raise RuntimeError("portal did not return a session_handle")
    session_handle = dbus.ObjectPath(str(handle))
    request_call(
        portal.SelectDevices,
        (session_handle,),
        dbus.Dictionary({
            "handle_token": dbus.String(token("devices")),
            "types": dbus.UInt32(DEVICE_KEYBOARD | DEVICE_POINTER),
        }, signature="sv"),
        timeout=15,
    )
    try:
        request_call(
            portal.Start,
            (session_handle, dbus.String("")),
            dbus.Dictionary({"handle_token": dbus.String(token("start"))}, signature="sv"),
            timeout=120,
        )
    except Exception:
        session_handle = None
        raise
    return session_handle


def notify(method, *args):
    handle = ensure_session()
    options = dbus.Dictionary({}, signature="sv")
    return method(handle, options, *args)


def pointer_to(x, y):
    # RemoteDesktop without a ScreenCast stream exposes relative motion. Clamp
    # to the top-left with an intentionally large negative delta, then move to
    # the requested primary-display coordinate. Compositors clamp at edges.
    notify(portal.NotifyPointerMotion, dbus.Double(-100000.0), dbus.Double(-100000.0))
    notify(portal.NotifyPointerMotion, dbus.Double(float(x)), dbus.Double(float(y)))


def key_event(keysym, state):
    notify(portal.NotifyKeyboardKeysym, dbus.Int32(int(keysym)), dbus.UInt32(state))


def type_text(text):
    for ch in text:
        cp = ord(ch)
        # X11/portal keysyms: Latin-1 is identical; other Unicode codepoints use
        # the standard 0x01000000 prefix.
        ks = cp if cp <= 0xFF else (0x01000000 | cp)
        key_event(ks, STATE_PRESSED)
        key_event(ks, STATE_RELEASED)


def handle(args):
    action = str(args.get("action") or "").lower()
    if action not in {"click", "double_click", "move", "scroll", "type", "key"}:
        raise ValueError("unsupported input action")
    if action in {"move", "click", "double_click"}:
        pointer_to(int(args.get("x") or 0), int(args.get("y") or 0))
    if action in {"click", "double_click"}:
        button = BTN.get(str(args.get("button") or "left").lower(), BTN["left"])
        count = 2 if action == "double_click" else 1
        for index in range(count):
            notify(portal.NotifyPointerButton, dbus.Int32(button), dbus.UInt32(STATE_PRESSED))
            notify(portal.NotifyPointerButton, dbus.Int32(button), dbus.UInt32(STATE_RELEASED))
            if index + 1 < count:
                time.sleep(0.08)
    elif action == "scroll":
        dx = float(args.get("delta_x") or 0)
        dy = float(args.get("delta_y") or 0)
        # Portal axis values are continuous; normalize huge UI wheel deltas.
        notify(portal.NotifyPointerAxis, dbus.Double(dx / 120.0), dbus.Double(dy / 120.0))
    elif action == "type":
        type_text(str(args.get("text") or "")[:65536])
    elif action == "key":
        keys = list(args.get("keys") or [])[:16]
        if not keys:
            raise ValueError("keys are required")
        for name in keys:
            text = str(name)
            ks = KEYSYM.get(text.lower())
            if ks is None:
                if len(text) != 1:
                    raise ValueError(f"unsupported key: {text}")
                cp = ord(text)
                ks = cp if cp <= 0xFF else (0x01000000 | cp)
            key_event(ks, STATE_PRESSED)
            key_event(ks, STATE_RELEASED)
    return {"ok": True, "action": action, "adapter": "xdg-remote-desktop-portal"}


print(json.dumps({"ready": True, "adapter": "xdg-remote-desktop-portal"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
        rid = req.get("id")
        result = handle(req.get("args") or {})
        print(json.dumps({"id": rid, "result": result}), flush=True)
    except Exception as exc:
        print(json.dumps({"id": (req.get("id") if 'req' in locals() and isinstance(req, dict) else None), "error": str(exc)}), flush=True)
