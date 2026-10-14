#!/usr/bin/env python3
# Watches the mouse on X11 for windows being dragged, for VibeCMD's Linux docking
# (see watchDrags in linuxdock.js). Talks to libX11 through ctypes, so nothing
# needs installing beyond Python 3.
#
# Prints one line per change, on stdout, in root window pixels:
#   press <frame> <client> <x> <y>        a button went down on a window's frame
#                                         (client: the window's own window, 0 if none)
#   move <x> <y> <shift> <moved>          the button is held; shift is 1 while Shift is
#                                         held; moved is 1 once the window has moved
#   release <x> <y> <shift> <moved>       the button came up
#
# Exits when the VibeCMD process that started it goes away.
import ctypes
import ctypes.util
import os
import sys
import time

BUTTON1_MASK = 1 << 8
SHIFT_MASK = 1 << 0
WINDOW = ctypes.c_ulong
ATOM = ctypes.c_ulong

X = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XOpenDisplay.restype = ctypes.c_void_p
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XDefaultRootWindow.restype = WINDOW
X.XQueryPointer.argtypes = [
    ctypes.c_void_p, WINDOW, ctypes.POINTER(WINDOW), ctypes.POINTER(WINDOW),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint),
]
X.XQueryPointer.restype = ctypes.c_int
X.XQueryTree.argtypes = [
    ctypes.c_void_p, WINDOW, ctypes.POINTER(WINDOW), ctypes.POINTER(WINDOW),
    ctypes.POINTER(ctypes.POINTER(WINDOW)), ctypes.POINTER(ctypes.c_uint),
]
X.XQueryTree.restype = ctypes.c_int
X.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
X.XInternAtom.restype = ATOM
X.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, WINDOW, ATOM, ctypes.c_long, ctypes.c_long, ctypes.c_int, ATOM,
    ctypes.POINTER(ATOM), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
]
X.XGetWindowProperty.restype = ctypes.c_int
X.XFree.argtypes = [ctypes.c_void_p]


class XWindowAttributes(ctypes.Structure):
    # The layout of Xlib's XWindowAttributes; only x and y are read.
    _fields_ = [
        ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
        ('border_width', ctypes.c_int), ('depth', ctypes.c_int), ('visual', ctypes.c_void_p),
        ('root', WINDOW), ('class', ctypes.c_int), ('bit_gravity', ctypes.c_int),
        ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int),
        ('backing_planes', ctypes.c_ulong), ('backing_pixel', ctypes.c_ulong),
        ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong), ('map_installed', ctypes.c_int),
        ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long),
        ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
        ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p),
    ]


X.XGetWindowAttributes.argtypes = [ctypes.c_void_p, WINDOW, ctypes.POINTER(XWindowAttributes)]
X.XGetWindowAttributes.restype = ctypes.c_int


def frame_pos(d, win):
    a = XWindowAttributes()
    if not X.XGetWindowAttributes(d, win, ctypes.byref(a)):
        return None
    return (a.x, a.y)


def has_wm_state(d, win, wm_state):
    actual = ATOM()
    fmt = ctypes.c_int()
    n = ctypes.c_ulong()
    after = ctypes.c_ulong()
    prop = ctypes.POINTER(ctypes.c_ubyte)()
    X.XGetWindowProperty(d, win, wm_state, 0, 2, 0, 0, ctypes.byref(actual), ctypes.byref(fmt),
                         ctypes.byref(n), ctypes.byref(after), ctypes.byref(prop))
    if prop:
        X.XFree(ctypes.cast(prop, ctypes.c_void_p))
    return n.value > 0


# The client window under a window manager's frame: the one that carries WM_STATE.
def client_of(d, win, wm_state, depth=0):
    if has_wm_state(d, win, wm_state):
        return win
    if depth >= 3:
        return 0
    root, parent = WINDOW(), WINDOW()
    kids = ctypes.POINTER(WINDOW)()
    n = ctypes.c_uint()
    if not X.XQueryTree(d, win, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(n)):
        return 0
    found = 0
    try:
        for i in range(n.value):
            found = client_of(d, kids[i], wm_state, depth + 1)
            if found:
                break
    finally:
        if kids:
            X.XFree(ctypes.cast(kids, ctypes.c_void_p))
    return found


def main():
    d = X.XOpenDisplay(None)
    if not d:
        sys.exit('no X display')
    root = X.XDefaultRootWindow(d)
    wm_state = X.XInternAtom(d, b'WM_STATE', 1)
    parent_pid = os.getppid()

    rr, child = WINDOW(), WINDOW()
    rx, ry, wx, wy = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    mask = ctypes.c_uint()
    held = False
    press = None  # {'frame', 'pos'}: the window pressed, and where its frame was then
    last = None

    while os.getppid() == parent_pid:
        ok = X.XQueryPointer(d, root, ctypes.byref(rr), ctypes.byref(child), ctypes.byref(rx),
                             ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
        if not ok:
            time.sleep(0.03)
            continue
        b1 = bool(mask.value & BUTTON1_MASK)
        shift = 1 if mask.value & SHIFT_MASK else 0
        x, y = rx.value, ry.value

        if press:
            cur = frame_pos(d, press['frame']) if press['pos'] else None
            moved = 1 if cur and cur != press['pos'] else 0
        else:
            moved = 0

        if b1 and not held:
            frame = child.value
            client = client_of(d, frame, wm_state) if frame else 0
            press = {'frame': frame, 'pos': frame_pos(d, frame) if frame else None}
            last = None
            print(f'press {frame} {client} {x} {y}', flush=True)
        elif b1 and press:
            state = (x, y, shift, moved)
            if state != last:
                last = state
                print(f'move {x} {y} {shift} {moved}', flush=True)
        elif not b1 and held and press:
            print(f'release {x} {y} {shift} {moved}', flush=True)
            press = None

        held = b1
        time.sleep(0.03)


if __name__ == '__main__':
    main()
