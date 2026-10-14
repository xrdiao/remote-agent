"""X11 window discovery and Wayland window-only capture through the system portal."""
import json
import os
import re
import subprocess
import sys


def windows():
    root = subprocess.check_output(['xprop', '-root', '_NET_CLIENT_LIST'], text=True)
    result = []
    for wid in re.findall(r'0x[0-9a-fA-F]+', root):
        try:
            props = subprocess.check_output(['xprop', '-id', wid, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID'], text=True, stderr=subprocess.DEVNULL)
            title = re.search(r'(?:_NET_WM_NAME|WM_NAME)\([^)]*\) = "(.*)"', props)
            pid = re.search(r'_NET_WM_PID\([^)]*\) = (\d+)', props)
            cls = re.search(r'WM_CLASS\([^)]*\) = (.*)', props)
            process = ''
            if pid:
                with open('/proc/' + pid[1] + '/comm') as f:
                    process = f.read().strip()
            if title:
                result.append({'id': str(int(wid, 16)), 'title': title[1], 'process': process, 'class': cls[1] if cls else ''})
        except (subprocess.CalledProcessError, OSError):
            continue
    print(json.dumps(result), flush=True)


def capture(state_path, restoring):
    import base64
    import signal
    import uuid
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gio, GLib, Gst

    Gst.init(None)
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    session = None
    pipeline = None
    signals = []
    state = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)

    def emit(value):
        print(json.dumps(value), flush=True)

    def call(method, signature, args, done):
        token = 'visual_' + uuid.uuid4().hex
        args[-1]['handle_token'] = GLib.Variant('s', token)
        request = '/org/freedesktop/portal/desktop/request/' + bus.get_unique_name()[1:].replace('.', '_') + '/' + token

        def response(conn, sender, path, interface, name, parameters, data):
            bus.signal_unsubscribe(subscription)
            code, values = parameters.unpack()
            if code:
                emit({'state': 'permission', 'message': '需要在电脑端选择并授权绘图或仿真窗口'})
                loop.quit()
            else:
                try:
                    done(values)
                except Exception as error:
                    emit({'state': 'error', 'message': str(error)})
                    loop.quit()

        subscription = bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', request, None, Gio.DBusSignalFlags.NONE, response, None)
        signals.append(subscription)
        bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.ScreenCast', method, GLib.Variant(signature, tuple(args)), None, Gio.DBusCallFlags.NONE, -1, None)

    def started(values):
        nonlocal pipeline
        streams = values.get('streams', [])
        if len(streams) != 1 or streams[0][1].get('source_type') != 2:
            raise RuntimeError('请选择单个绘图或仿真窗口')
        restore = values.get('restore_token')
        state['restoreToken'] = restore or ''
        with open(state_path, 'w') as f:
            json.dump(state, f)
        os.chmod(state_path, 0o600)
        handles = Gio.UnixFDList.new()
        result, fds = bus.call_with_unix_fd_list_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.ScreenCast', 'OpenPipeWireRemote', GLib.Variant('(oa{sv})', (session, {})), None, Gio.DBusCallFlags.NONE, -1, handles, None)
        fd = fds.get(result.unpack()[0])
        node, props = streams[0]
        pipeline = Gst.parse_launch(f'pipewiresrc fd={fd} path={node} do-timestamp=true ! videoconvert ! videoscale ! videorate ! video/x-raw,width=[1,1280],framerate=8/1,pixel-aspect-ratio=1/1 ! jpegenc quality=70 ! appsink name=frames emit-signals=true max-buffers=1 drop=true sync=false')

        def frame(sink):
            sample = sink.emit('pull-sample')
            buf = sample.get_buffer()
            ok, mapped = buf.map(Gst.MapFlags.READ)
            if ok:
                caps = sample.get_caps().get_structure(0)
                emit({'frame': base64.b64encode(mapped.data).decode(), 'w': caps.get_value('width'), 'h': caps.get_value('height')})
                buf.unmap(mapped)
            return Gst.FlowReturn.OK

        def message(bus, message):
            if message.type == Gst.MessageType.ERROR:
                error, detail = message.parse_error()
                emit({'state': 'error', 'message': str(error)})
                loop.quit()
            elif message.type == Gst.MessageType.EOS:
                loop.quit()

        pipeline.get_by_name('frames').connect('new-sample', frame)
        pipeline.get_bus().add_signal_watch()
        pipeline.get_bus().connect('message', message)
        pipeline.set_state(Gst.State.PLAYING)
        emit({'state': 'live', 'title': '已授权窗口'})

    def selected(values):
        call('Start', '(osa{sv})', [session, '', {}], started)

    def created(values):
        nonlocal session
        session = values['session_handle']
        options = {'types': GLib.Variant('u', 2), 'multiple': GLib.Variant('b', False), 'persist_mode': GLib.Variant('u', 2)}
        if restoring and state.get('restoreToken'):
            options['restore_token'] = GLib.Variant('s', state['restoreToken'])
        call('SelectSources', '(oa{sv})', [session, options], selected)

    def stop(*unused):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    emit({'state': 'permission', 'message': '正在恢复窗口授权；如电脑弹出选择框，请选择绘图或仿真窗口' if restoring else '请在电脑端选择并授权绘图或仿真窗口'})
    try:
        call('CreateSession', '(a{sv})', [{'session_handle_token': GLib.Variant('s', 'visual_' + uuid.uuid4().hex)}], created)
        loop.run()
    finally:
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        if session:
            bus.call_sync('org.freedesktop.portal.Desktop', session, 'org.freedesktop.portal.Session', 'Close', None, None, Gio.DBusCallFlags.NONE, -1, None)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'list':
            windows()
        else:
            capture(sys.argv[2], sys.argv[3] == 'restore')
    except Exception as error:
        print(json.dumps({'state': 'error', 'message': str(error)}), flush=True)
        sys.exit(1)
