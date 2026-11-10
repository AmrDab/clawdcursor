#!/usr/bin/env python3
"""
Test driver for scripts/linux/*.py — run by src/__tests__/linux-python-scripts.test.ts.

Loads the two Linux helper scripts as modules (with a fake `gi.repository.Atspi`
installed so atspi-bridge.py imports on any OS) and exercises their parsing /
dispatch logic against hand-built objects. Prints one JSON object to stdout;
the vitest side asserts on it. No real tesseract / AT-SPI needed.

Usage: python linux-scripts-driver.py <path-to-scripts/linux>
"""
import importlib.util
import json
import os
import sys
import threading
import types

SCRIPTS = sys.argv[1]
OUT = {}


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── OCR: tesseract 5 TSV with float confidences ──────────────────────────

ocr = load('ocr_recognize', 'ocr-recognize.py')
TSV = (
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    "1\t1\t0\t0\t0\t0\t0\t0\t1920\t1080\t-1\t\n"
    "5\t1\t1\t1\t1\t1\t10\t20\t50\t15\t81.879456\tHello\n"
    "5\t1\t1\t1\t1\t2\t70\t20\t55\t15\t96.4\tWorld\n"
    "5\t1\t1\t1\t2\t1\t10\t50\t40\t15\t0.0\tTest\n"
    "5\t1\t1\t1\t2\t2\t60\t50\t40\t15\t-1\t\n"
)
OUT['ocr'] = ocr.parse_tsv(TSV)
# The caller OCRs a 2x-upscaled capture and passes the factor back.
OUT['ocr_scaled'] = ocr.parse_tsv(TSV, 2.0)
# Sparse mode: separate blocks each restart line_num at 1.
SPARSE = (
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    "5\t1\t1\t1\t1\t1\t10\t20\t50\t15\t90\tSubmit\n"
    "5\t1\t2\t1\t1\t1\t10\t80\t50\t15\t90\tCancel\n"
)
OUT['ocr_sparse'] = ocr.parse_tsv(SPARSE)
# xcalc in sparse mode: every label its own block, all line_num 1. "sin" and
# the "@" one row below must land on different lines; "Save" + "As" (own
# blocks, same row) on one.
ROWS = (
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    "5\t1\t1\t1\t1\t1\t262\t699\t30\t14\t94\tsin\n"
    "5\t1\t2\t1\t1\t1\t259\t735\t10\t14\t10\t@\n"
    "5\t1\t3\t1\t1\t1\t400\t701\t30\t14\t90\ttan\n"
    "5\t1\t4\t1\t1\t1\t500\t900\t40\t16\t95\tSave\n"
    "5\t1\t5\t1\t1\t1\t546\t901\t20\t16\t95\tAs\n"
)
OUT['ocr_rows'] = {e['text']: e['line'] for e in ocr.parse_tsv(ROWS)['elements']}
OUT['ocr_psm'] = ocr.PSM


# ── AT-SPI bridge with a fake Atspi ──────────────────────────────────────

class CoordType:
    SCREEN = 0
    WINDOW = 1
    PARENT = 2


class StateType:
    (FOCUSED, ENABLED, SENSITIVE, SELECTED, BUSY, VISIBLE, SHOWING,
     CHECKED, PRESSED, EXPANDED, EXPANDABLE, EDITABLE, ACTIVE, CHECKABLE, INDETERMINATE) = range(15)


class Cache:
    NONE = 0
    ALL = 1


class Rect:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.width, self.height = x, y, w, h


class StateSet:
    def __init__(self, states):
        self.states = set(states)

    def contains(self, st):
        return st in self.states

    def is_empty(self):
        return not self.states


class Component:
    def __init__(self, acc):
        self.acc = acc

    def get_extents(self, ct):
        r = self.acc.screen if ct == CoordType.SCREEN else self.acc.window
        return Rect(*r)

    def grab_focus(self):
        self.acc.states.add(StateType.FOCUSED)
        return True


class Action:
    def __init__(self, acc, names):
        self.acc = acc
        self.names = names
        self.done = []

    def get_n_actions(self):
        return len(self.names)

    def get_action_name(self, i):
        return self.names[i]

    def do_action(self, i):
        self.done.append(self.names[i])
        if self.acc.lag is not None:
            # A toolkit that updates its state set after the action returns (Chromium); lag 0 = never updates.
            if self.acc.lag:
                threading.Timer(self.acc.lag, lambda: self.acc.states.symmetric_difference_update({StateType.CHECKED})).start()
        elif self.names[i] == 'toggle' or self.acc.role == 'check box':
            self.acc.states ^= {StateType.CHECKED}
        if self.names[i] in ('expand', 'collapse'):
            self.acc.states ^= {StateType.EXPANDED}
        return True


class Text:
    """Atspi.Text as PyGObject exposes it: interface functions taking the
    Accessible as their first argument."""
    @staticmethod
    def get_character_count(acc):
        return len(acc.text or '')

    @staticmethod
    def get_text(acc, a, b):
        return (acc.text or '')[a:b]


class EditableText:
    def __init__(self, acc):
        self.acc = acc

    def set_text_contents(self, s):
        self.acc.text = s
        return True


class Value:
    def __init__(self, acc):
        self.acc = acc

    def get_current_value(self):
        return self.acc.value

    def set_current_value(self, v):
        self.acc.value = v
        return True


class Selection:
    def __init__(self, acc):
        self.acc = acc
        self.selected = []

    def select_child(self, i):
        self.selected.append(i)
        self.acc.children[i].states.add(StateType.SELECTED)
        return True


class Acc:
    def __init__(self, name, role, states=(StateType.ENABLED, StateType.SENSITIVE, StateType.VISIBLE, StateType.SHOWING),
                 screen=(10, 20, 30, 40), window=(0, 0, 0, 0), actions=None, children=(), pid=4242,
                 text=None, editable=False, value=None, selection=False, lag=None):
        self.name, self.role, self.states = name, role, set(states)
        self.lag = lag
        self.screen, self.window = screen, window
        self.action = Action(self, actions) if actions is not None else None
        self.children = list(children)
        for c in self.children:
            c.parent = self
        self.parent = None
        self.pid = pid
        self.text, self.editable, self.value = text, editable, value
        self.selection = Selection(self) if selection else None
        self.component = Component(self)

    def get_name(self): return self.name
    def get_role_name(self): return self.role
    def get_state_set(self): return StateSet(self.states)
    def get_component_iface(self): return self.component
    def get_action_iface(self): return self.action
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, i): return self.children[i]
    def get_process_id(self): return self.pid
    def get_accessible_id(self): return None
    def get_value_iface(self): return Value(self) if self.value is not None else None
    # Real PyGObject: get_text_iface() returns the Accessible itself, and
    # Accessible.get_text is the deprecated NO-ARGUMENT getter that shadows
    # Text.get_text(start, end) — calling .get_text(0, n) on it raises.
    def get_text_iface(self): return self if self.text is not None else None
    def get_text(self): return self
    def get_editable_text_iface(self): return EditableText(self) if self.editable else None
    def get_selection_iface(self): return self.selection
    def get_parent(self): return self.parent
    def get_index_in_parent(self): return self.parent.children.index(self) if self.parent else -1
    def set_cache_mask(self, m): self.cache_mask = m


seven = Acc('7', 'push button', actions=['press', 'click'])
agree = Acc('Agree', 'check box', actions=['toggle'])
late = Acc('Late', 'check box', actions=['toggle'], lag=0.2)
stuck = Acc('Stuck', 'check box', actions=['toggle'], lag=0)
name_field = Acc('Name', 'text', text='old', editable=True)
display = Acc('Display', 'label', text='42')
canvas = Acc('canvas', 'drawing area', actions=None)
tab1 = Acc('Tab 1', 'page tab')
tab2 = Acc('Tab 2', 'page tab')
tabs = Acc('', 'page tab list', children=[tab1, tab2], selection=True)
empty_state = Acc('Ghost', 'push button', states=())
sensitive_only = Acc('Half', 'push button', states=(StateType.SENSITIVE,))
rel = Acc('Rel', 'push button', screen=(0, 0, 0, 0), window=(5, 6, 7, 8))
node = Acc('Node', 'tree item', states=(StateType.ENABLED, StateType.SENSITIVE, StateType.EXPANDABLE,
                                       StateType.VISIBLE, StateType.SHOWING), actions=['expand'])
# GTK4 on X11: SCREEN extents are 0,0 with the real size; WINDOW has the position.
gtk4 = Acc('Gtk4', 'push button', screen=(0, 0, 64, 44), window=(16, 349, 64, 44))
frame = Acc('Calculator', 'frame', screen=(100, 200, 800, 600),
            children=[seven, agree, late, stuck, name_field, display, canvas, tabs, empty_state, sensitive_only, rel, node, gtk4])
calc_app = Acc('gnome-calculator', 'application', children=[frame], pid=4242)
# Another app whose (inactive) window still holds FOCUSED on a widget.
other_app = Acc('mousepad', 'application', pid=5555, children=[
    Acc('7', 'push button', pid=5555),
    Acc('', 'text', pid=5555, text='other app', states=(StateType.FOCUSED, StateType.VISIBLE, StateType.SHOWING)),
])
# An editor with a Save dialog open over its main window: the main window has
# a closed menu + a hidden toolbar "Save" (0x0) and keeps FOCUSED on its text
# view; the ACTIVE dialog has the real, visible "Save" button.
HIDDEN = (StateType.ENABLED, StateType.SENSITIVE)
toolbar_save = Acc('Save', 'push button', states=HIDDEN, screen=(0, 0, 0, 0), actions=['click'], pid=7777)
menu_save = Acc('Save      ', 'menu item', states=HIDDEN, screen=(0, 0, 0, 0), actions=['click'], pid=7777)
only_hidden = Acc('Preview', 'menu item', states=HIDDEN, screen=(0, 0, 0, 0), actions=['click'], pid=7777)
# Hidden too, but in the INACTIVE main window: find / invoke do not look there at all.
elsewhere_hidden = Acc('Print', 'menu item', states=HIDDEN, screen=(0, 0, 0, 0), actions=['click'], pid=7777)
main_view = Acc('', 'text', pid=7777, text='hello world', screen=(5, 50, 400, 300),
                states=(StateType.FOCUSED, StateType.VISIBLE, StateType.SHOWING, StateType.ENABLED))
nameless_row = Acc('', 'list item', pid=7777, screen=(5, 400, 100, 20))
main_win = Acc('notes.txt - Editor', 'frame', screen=(0, 0, 640, 480), pid=7777,
               children=[menu_save, elsewhere_hidden, toolbar_save, main_view, nameless_row])
dialog_save = Acc('Save', 'push button', screen=(500, 600, 80, 30), actions=['click'], pid=7777)
file_name = Acc('Name', 'text', pid=7777, text='notes.txt', editable=True, screen=(300, 200, 200, 25),
                states=(StateType.FOCUSED, StateType.VISIBLE, StateType.SHOWING, StateType.ENABLED))
dialog = Acc('Save As', 'file chooser', screen=(200, 100, 600, 560), pid=7777,
             states=(StateType.ACTIVE, StateType.ENABLED, StateType.VISIBLE, StateType.SHOWING),
             children=[file_name, dialog_save, only_hidden])
editor_app = Acc('editor', 'application', children=[main_win, dialog], pid=7777, screen=(0, 0, 0, 0))
desktop = Acc('main', 'desktop frame', children=[other_app, calc_app, editor_app], pid=0)

gi = types.ModuleType('gi')
gi.require_version = lambda *a, **k: None
repo = types.ModuleType('gi.repository')
repo.Atspi = types.SimpleNamespace(CoordType=CoordType, StateType=StateType, Cache=Cache, Text=Text,
                                   get_desktop=lambda i: desktop)
gi.repository = repo
sys.modules['gi'] = gi
sys.modules['gi.repository'] = repo

bridge = load('atspi_bridge', 'atspi-bridge.py')

OUT['find_scoped'] = bridge.cmd_find('7', None, 4242)
OUT['find_other'] = bridge.cmd_find('7', None, 5555)
OUT['empty_state'] = bridge.node_to_dict(empty_state)
OUT['sensitive_only'] = bridge.node_to_dict(sensitive_only)
OUT['rel'] = bridge.node_to_dict(rel)
OUT['seven'] = bridge.node_to_dict(seven)

OUT['click'] = bridge.cmd_invoke('7', None, 4242, 'click', None)
OUT['click_done'] = seven.action.done
OUT['toggle'] = bridge.cmd_invoke('Agree', None, 4242, 'toggle', None)
OUT['agree_after'] = bridge.node_to_dict(agree)
# A push button is neither a tickbox nor an expander: refused, never pressed (the click fallback used to press it).
seven_done_before = list(seven.action.done)
OUT['toggle_button'] = bridge.cmd_invoke('7', None, 4242, 'toggle', None)
OUT['expand_button'] = bridge.cmd_invoke('7', None, 4242, 'expand', None)
OUT['button_pressed_again'] = seven.action.done != seven_done_before
OUT['toggle_late'] = bridge.cmd_invoke('Late', None, 4242, 'toggle', None)
OUT['toggle_stuck'] = bridge.cmd_invoke('Stuck', None, 4242, 'toggle', None)
OUT['focus'] = bridge.cmd_invoke('Name', None, 4242, 'focus', None)
OUT['focus_state'] = StateType.FOCUSED in name_field.states
OUT['set_value'] = bridge.cmd_invoke('Name', None, 4242, 'set-value', 'Ada')
OUT['set_value_text'] = name_field.text
OUT['get_value'] = bridge.cmd_invoke('Display', None, 4242, 'get-value', None)
OUT['select'] = bridge.cmd_invoke('Tab 2', None, 4242, 'select', None)
OUT['select_idx'] = tabs.selection.selected
OUT['expand'] = bridge.cmd_invoke('Node', None, 4242, 'expand', None)
OUT['no_action'] = bridge.cmd_invoke('canvas', None, 4242, 'click', None)
OUT['missing'] = bridge.cmd_invoke('nope', None, 4242, 'click', None)
OUT['cache_mask'] = getattr(calc_app, 'cache_mask', None)

# Text views: value comes from the Text interface (was always empty).
OUT['text_view'] = bridge.node_to_dict(main_view)
OUT['gtk4'] = bridge.node_to_dict(gtk4)
OUT['label_value'] = bridge.node_to_dict(Acc('Seven', 'label', text='Seven'))['value']

# Hidden duplicates: the dialog's visible Save wins over the hidden toolbar one.
OUT['save'] = bridge.cmd_invoke('Save', None, 7777, 'click', None)
OUT['save_done'] = {'dialog': dialog_save.action.done, 'toolbar': toolbar_save.action.done,
                    'menu': menu_save.action.done}
OUT['hidden_only'] = bridge.cmd_invoke('Preview', None, 7777, 'click', None)
OUT['other_window'] = bridge.cmd_invoke('Print', None, 7777, 'click', None)
OUT['other_window_done'] = elsewhere_hidden.action.done
OUT['hidden_only_done'] = only_hidden.action.done

# Tree order: on-screen elements first (active dialog first), hidden last,
# nameless rows dropped.
OUT['tree'] = [(e['name'], e['controlType']) for e in bridge.cmd_get_tree(7777)['elements']]

# Depth: a Chromium page nests its controls 15-30 levels deep; a walk that stops short must say it was cut.
def chain(levels, leaf):
    node = leaf
    for i in range(levels):
        node = Acc('', 'section', children=[node])
    return node
deep_out, deep_cut = [], [False]
bridge.walk(chain(30, Acc('Deep button', 'push button')), deep_out, 1, deep_cut)
OUT['deep_found'] = any(e['name'] == 'Deep button' for e in deep_out)
OUT['deep_cut'] = deep_cut[0]
too_deep_out, too_deep_cut = [], [False]
bridge.walk(chain(bridge.MAX_TREE_DEPTH + 5, Acc('Too deep', 'push button')), too_deep_out, 1, too_deep_cut)
OUT['too_deep_cut'] = too_deep_cut[0]
# A search has its own visit budget (MAX_SEARCH_NODES), larger than the tree's output cap: a file manager with
# 1,000 files still finds its 1,000th row. find_target counts nodes visited, not matches, so a name that matches
# nothing stops there, and says the search was cut.
def wide_app(n):
    page = Acc('page', 'document web', children=[Acc('row %d' % i, 'section') for i in range(n)] + [Acc('Needle', 'push button')])
    return Acc('app', 'application', pid=5151, children=[page])
OUT['search_over_tree_cap'] = bridge.MAX_SEARCH_NODES > bridge.MAX_TREE_NODES
bridge.SEARCH_CUT[0] = False
OUT['wide_found'] = bridge.find_target(wide_app(bridge.MAX_TREE_NODES * 2), 'Needle', None)[0] is not None
OUT['wide_found_cut'] = bridge.SEARCH_CUT[0]
bridge.SEARCH_CUT[0] = False
OUT['wide_capped'] = bridge.find_target(wide_app(bridge.MAX_SEARCH_NODES * 2), 'Needle', None)[0] is None
OUT['wide_capped_cut'] = bridge.SEARCH_CUT[0]
real_active_application = bridge.active_application
wide_acc = wide_app(bridge.MAX_SEARCH_NODES * 2)
bridge.active_application = lambda *a, **k: wide_acc
OUT['wide_invoke'] = bridge.cmd_invoke('Needle', None, 5151, 'click', None)
OUT['wide_find'] = bridge.cmd_find('Needle', None, 5151)
wide_acc = wide_app(bridge.MAX_TREE_NODES * 2)
OUT['wide_find_small'] = [e['name'] for e in bridge.cmd_find('Needle', None, 5151)['elements']]
wide_acc = wide_app(bridge.MAX_SEARCH_NODES * 2)
OUT['wide_scroll'] = bridge.cmd_scroll_into_view('Needle', None, 5151)
focus_acc = wide_app(bridge.MAX_SEARCH_NODES * 2)
focus_acc.children[0].children[-1].states.add(StateType.FOCUSED)
wide_acc = focus_acc
OUT['wide_focused'] = bridge.cmd_focused(5151)

# find builds an element dict (about ten AT-SPI calls) only for hits, not for every node it walks.
wide_acc = wide_app(1500)
real_node_to_dict, dict_calls = bridge.node_to_dict, [0]
def counting_node_to_dict(acc):
    dict_calls[0] += 1
    return real_node_to_dict(acc)
bridge.node_to_dict = counting_node_to_dict
OUT['find_names'] = [e['name'] for e in bridge.cmd_find('Needle', None, 5151)['elements']]
OUT['find_dict_calls'] = dict_calls[0]
# A role-only find searches too, and reports a cut one.
wide_acc = wide_app(bridge.MAX_SEARCH_NODES * 2)
OUT['role_find'] = bridge.cmd_find(None, 'no such role', 5151)
bridge.node_to_dict = real_node_to_dict

# Deadline: a slow tree ends the search as cut ('time limit') instead of running into the caller's timeout.
clock = [0.0]
class SlowAcc(Acc):
    def get_name(self):
        clock[0] += 1.0
        return self.name
    def get_state_set(self):
        clock[0] += 1.0
        return super().get_state_set()
slow_page = Acc('page', 'document web', children=[SlowAcc('row %d' % i, 'section') for i in range(60)] + [SlowAcc('Needle', 'push button')])
slow_acc = Acc('app', 'application', pid=5151, children=[slow_page])
real_now = bridge._now
bridge._now = lambda: clock[0]
wide_acc = slow_acc
def timed(fn):
    clock[0] = 0.0
    r = fn()
    return r
bridge.begin_search()
OUT['slow_target'] = [bridge.find_target(slow_acc, 'Needle', None)[0] is None, bridge.SEARCH_CUT[0], clock[0]]
clock[0] = 0.0
OUT['slow_find'] = bridge.cmd_find('Needle', None, 5151)
clock[0] = 0.0
OUT['slow_invoke'] = bridge.cmd_invoke('Needle', None, 5151, 'click', None)
clock[0] = 0.0
OUT['slow_scroll'] = bridge.cmd_scroll_into_view('Needle', None, 5151)
clock[0] = 0.0
slow_page.children[-1].states.add(StateType.FOCUSED)
OUT['slow_focused'] = bridge.cmd_focused(5151)
bridge._now = real_now

# The hit list is capped (each hit costs about ten AT-SPI calls to describe) and says it was cut.
items_acc = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('file %d' % i, 'list item') for i in range(2000)])])
wide_acc = items_acc
cap_res = bridge.cmd_find(None, 'list item', 5151)
OUT['hit_cap'] = {'n': len(cap_res['elements']), 'partial': cap_res.get('partial'), 'reason': cap_res.get('reason'), 'max': bridge.MAX_TREE_NODES}
# The deadline holds while describing hits too: every dict costs a second on a fake clock.
clock[0] = 0.0
bridge._now = lambda: clock[0]
slow_dict_orig = bridge.node_to_dict
def slow_dict(acc):
    clock[0] += 1.0
    return slow_dict_orig(acc)
bridge.node_to_dict = slow_dict
few_acc = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('file %d' % i, 'list item') for i in range(30)])])
wide_acc = few_acc
slow_res = bridge.cmd_find(None, 'list item', 5151)
OUT['dict_deadline'] = {'n': len(slow_res['elements']), 'partial': slow_res.get('partial'), 'reason': slow_res.get('reason')}
bridge.node_to_dict = slow_dict_orig
bridge._now = real_now

# Multi-word roles outside the role map: the caller sends the normalized name, AT-SPI spells it with a space.
OUT['role_squeeze'] = [bridge.role_matches(['tooltip'], 'tool tip'), bridge.role_matches(['infobar'], 'info bar'), bridge.role_matches(['button'], 'tool tip')]
wide_acc = Acc('app', 'application', pid=5151, children=[Acc('win', 'frame', children=[Acc('Hint', 'tool tip'), Acc('Warn', 'info bar'), Acc('Ok', 'push button')])])
OUT['tooltip_find'] = [e['name'] for e in bridge.cmd_find(None, 'tooltip', 5151)['elements']]
OUT['infobar_find'] = [e['name'] for e in bridge.cmd_find(None, 'infobar', 5151)['elements']]

# A cut search does not act on a weaker match (substring) when an exact one may lie beyond the cut.
weak_page = Acc('page', 'document web', children=[Acc('Save as draft', 'push button')] + [Acc('row %d' % i, 'section') for i in range(bridge.MAX_SEARCH_NODES * 2)] + [Acc('Save', 'push button')])
wide_acc = Acc('app', 'application', pid=5151, children=[weak_page])
OUT['weak_cut'] = bridge.cmd_invoke('Save', None, 5151, 'click', None)
small_weak = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('Save as draft', 'push button', actions=['click'])])])
bridge.begin_search()
OUT['weak_uncut'] = bridge.find_target(small_weak, 'Save', None)[0] is not None

# scroll-into-view: a cut search (budget) does not scroll to the matches it saw; an uncut one does.
scroll_cut = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('Target', 'push button')] + [Acc('row %d' % i, 'section') for i in range(bridge.MAX_SEARCH_NODES * 2)])])
wide_acc = scroll_cut
OUT['scroll_after_cut'] = bridge.cmd_scroll_into_view('Target', None, 5151)   # an EXACT match, then a cut: proceeds
scroll_weak = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('Target item', 'push button')] + [Acc('row %d' % i, 'section') for i in range(bridge.MAX_SEARCH_NODES * 2)])])
wide_acc = scroll_weak
OUT['scroll_weak_cut'] = bridge.cmd_scroll_into_view('Target', None, 5151)    # substring only, then a cut: refused
scroll_ok = Acc('app', 'application', pid=5151, children=[Acc('page', 'document web', children=[Acc('Target', 'push button')])])
wide_acc = scroll_ok
OUT['scroll_uncut'] = bridge.cmd_scroll_into_view('Target', None, 5151)

# Depth limit is named as such.
deep_acc = Acc('app', 'application', pid=5151, children=[chain(bridge.MAX_TREE_DEPTH + 5, Acc('Too deep', 'push button'))])
bridge.begin_search()
OUT['deep_target'] = [bridge.find_target(deep_acc, 'Too deep', None)[0] is None, bridge.SEARCH_CUT[0]]
bridge.active_application = real_active_application

# Focus: scoped to the app, active window first — never another app's widget.
OUT['focused_editor'] = bridge.cmd_focused(7777)['element']
name_field.states.discard(StateType.FOCUSED)  # focused by the 'focus' invoke above
OUT['focused_calc'] = bridge.cmd_focused(4242)['element']

# Window without _NET_WM_PID: scope by the active window's title.
OUT['by_title'] = [e['processId'] for e in bridge.cmd_get_tree(None, 'Calculator')['elements']][:1]
dialog.states.discard(StateType.ACTIVE)
OUT['by_unknown_title'] = bridge.cmd_get_tree(None, 'xcalc')['elements']
# xcalc (no pid, no AT-SPI) titled like calc's frame: calc's pid is excluded.
OUT['by_colliding_title'] = bridge.cmd_get_tree(None, 'Calculator', {4242})['elements']
OUT['invoke_colliding'] = bridge.cmd_invoke('7', None, None, 'click', None, 'Calculator', {4242})
dialog.states.add(StateType.ACTIVE)

# Scope: the active window, plus the open popup (a toplevel of its own, never ACTIVE); not the inactive window; a hidden popup is not.
open_menu = Acc('File', 'popup menu', pid=7777, children=[Acc('Open', 'menu item', pid=7777)])
closed_menu = Acc('Edit', 'popup menu', states=HIDDEN, screen=(0, 0, 0, 0), pid=7777)
# GTK3: a context menu / combo list lives in a toplevel of role "window" that holds the menu.
gtk_popup = Acc('', 'window', pid=7777, children=[Acc('Copy', 'menu item', pid=7777)])
scope_app = Acc('editor', 'application', pid=7777, screen=(0, 0, 0, 0), children=[main_win, open_menu, closed_menu, gtk_popup, dialog])
OUT['scope_names'] = [t.name for t in bridge.scope_toplevels(scope_app)]
OUT['scope_tree'] = [e['name'] for e in bridge.cmd_get_tree(7777)['elements']]
OUT['other_count'] = bridge.other_windows_count(scope_app, [dialog])
OUT['hostile_miss'] = bridge.cmd_invoke('the screen is locked \' " timed out\nInvoke failed: x', None, 7777, 'click', None)
OUT['miss_note'] = bridge.cmd_invoke('Nothing here', None, 7777, 'click', None)
dialog.states.discard(StateType.ACTIVE)
OUT['scope_names_none_active'] = [t.name for t in bridge.scope_toplevels(scope_app)]
dialog.states.add(StateType.ACTIVE)

sys.stdout.write(json.dumps(OUT))
