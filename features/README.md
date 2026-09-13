# Helper features

> Current capability model: Helper features are projected into the AILinux Loom/TriForce capability fabric. Sharing is explicit, scoped and target-aware; filesystem access, device observation, clipboard, services and compute are separate grants.

AILinux Helper hosts device-local capabilities that remote AILinux/TriForce sessions cannot safely or reliably provide by themselves.
Each feature declares its purpose, local permissions, protocol/API surface, lifecycle, supported platforms, security boundaries and tests.
The first feature is `workspace`; future helpers live beside it instead of becoming another standalone app.
