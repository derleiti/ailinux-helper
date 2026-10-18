#!/usr/bin/python3
"""Single-use, nonce-bound D-Bus reply endpoint for the KWin 6 bridge."""
import json
import re
import sys
import dbus
import dbus.service
import dbus.mainloop.glib
from gi.repository import GLib

nonce = sys.argv[1] if len(sys.argv) == 2 else ''
if not re.fullmatch(r'[a-f0-9]{24}', nonce):
    raise SystemExit('invalid request id')

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
loop = GLib.MainLoop()
bus = dbus.SessionBus()
name = dbus.service.BusName('me.ailinux.KWinHelper.n' + nonce, bus=bus, do_not_queue=True)

class Receiver(dbus.service.Object):
    @dbus.service.method('me.ailinux.KWinHelper', in_signature='ss', out_signature='')
    def Result(self, request_id, payload):
        if request_id != nonce:
            return
        if len(payload) > 131072:
            print(json.dumps({'type': 'error', 'error': 'KWin result too large'}), flush=True)
        else:
            print(json.dumps({'type': 'result', 'payload': str(payload)}), flush=True)
        GLib.idle_add(loop.quit)

receiver = Receiver(bus, '/me/ailinux/KWinHelper')
print(json.dumps({'type': 'ready'}), flush=True)
loop.run()
