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
OUT['ocr_psm'] = ocr.PSM


# ── AT-SPI bridge with a fake Atspi ──────────────────────────────────────

class CoordType:
    SCREEN = 0
    WINDOW = 1
    PARENT = 2


class StateType:
    (FOCUSED, ENABLED, SENSITIVE, SELECTED, BUSY, VISIBLE, SHOWING,
     CHECKED, PRESSED, EXPANDED, EXPANDABLE, EDITABLE) = range(12)


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
        if self.names[i] == 'toggle' or self.acc.role == 'check box':
            self.acc.states ^= {StateType.CHECKED}
        if self.names[i] in ('expand', 'collapse'):
            self.acc.states ^= {StateType.EXPANDED}
        return True


class Text:
    def __init__(self, acc):
        self.acc = acc

    def get_character_count(self):
        return len(self.acc.text or '')

    def get_text(self, a, b):
        return (self.acc.text or '')[a:b]


class EditableText(Text):
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
                 text=None, editable=False, value=None, selection=False):
        self.name, self.role, self.states = name, role, set(states)
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
    def get_text_iface(self): return Text(self) if self.text is not None else None
    def get_editable_text_iface(self): return EditableText(self) if self.editable else None
    def get_selection_iface(self): return self.selection
    def get_parent(self): return self.parent
    def get_index_in_parent(self): return self.parent.children.index(self) if self.parent else -1
    def set_cache_mask(self, m): self.cache_mask = m


seven = Acc('7', 'push button', actions=['press', 'click'])
agree = Acc('Agree', 'check box', actions=['toggle'])
name_field = Acc('Name', 'text', text='old', editable=True)
display = Acc('Display', 'label', text='42')
canvas = Acc('canvas', 'drawing area', actions=None)
tab1 = Acc('Tab 1', 'page tab')
tab2 = Acc('Tab 2', 'page tab')
tabs = Acc('', 'page tab list', children=[tab1, tab2], selection=True)
empty_state = Acc('Ghost', 'push button', states=())
sensitive_only = Acc('Half', 'push button', states=(StateType.SENSITIVE,))
rel = Acc('Rel', 'push button', screen=(0, 0, 0, 0), window=(5, 6, 7, 8))
node = Acc('Node', 'tree item', states=(StateType.ENABLED, StateType.SENSITIVE, StateType.EXPANDABLE), actions=['expand'])
frame = Acc('Calculator', 'frame', screen=(100, 200, 800, 600),
            children=[seven, agree, name_field, display, canvas, tabs, empty_state, sensitive_only, rel, node])
calc_app = Acc('gnome-calculator', 'application', children=[frame], pid=4242)
other_app = Acc('mousepad', 'application', children=[Acc('7', 'push button', pid=5555)], pid=5555)
desktop = Acc('main', 'desktop frame', children=[other_app, calc_app], pid=0)

gi = types.ModuleType('gi')
gi.require_version = lambda *a, **k: None
repo = types.ModuleType('gi.repository')
repo.Atspi = types.SimpleNamespace(CoordType=CoordType, StateType=StateType, Cache=Cache,
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

sys.stdout.write(json.dumps(OUT))
