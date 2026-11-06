"""Biểu tượng khay hệ thống qua giao thức StatusNotifierItem + dbusmenu, nói chuyện thẳng bằng D-Bus.

Không dùng AppIndicator vì nó cần GTK3, không chạy chung được với GTK4 (và GTK3 đang crash trên GNOME mới).
GNOME cần tiện ích AppIndicator/KStatusNotifierItem (Ubuntu bật sẵn: ubuntu-appindicators).
"""
import os

from gi.repository import Gio, GLib

SNI_XML = """<node><interface name="org.kde.StatusNotifierItem">
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconThemePath" type="s" access="read"/><property name="Menu" type="o" access="read"/>
<property name="ItemIsMenu" type="b" access="read"/>
<method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
<signal name="NewStatus"><arg type="s"/></signal>
</interface></node>"""

MENU_XML = """<node><interface name="com.canonical.dbusmenu">
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
<method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
<arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/>
<arg type="a(ia{sv})" direction="out"/></method>
<method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
<method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method>
<method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
<method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method>
<signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
</interface></node>"""

ITEM_PATH, MENU_PATH = '/StatusNotifierItem', '/MenuBar'
V = GLib.Variant


class Tray:
    def __init__(self, on_show, on_scan, on_quit, icon_dir):
        self.icon_dir = icon_dir
        # id -> (nhãn, hàm); nhãn None là đường kẻ ngang
        self.entries = {1: ('Mở Disk Cleaner', on_show), 2: ('Quét ngay', on_scan), 3: (None, None), 4: ('Thoát', on_quit)}
        self.conn = None
        self.ids = []
        self.owner = 0

    # ---------- vòng đời ----------
    def start(self):
        if self.conn:
            return True
        try:
            self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            name = f'org.kde.StatusNotifierItem-{os.getpid()}-1'
            self.owner = Gio.bus_own_name_on_connection(self.conn, name, Gio.BusNameOwnerFlags.NONE, None, None)
            self.ids.append(self.conn.register_object(ITEM_PATH, Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0],
                                                      self._sni_call, self._sni_prop, None))
            self.ids.append(self.conn.register_object(MENU_PATH, Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0],
                                                      self._menu_call, self._menu_prop, None))
            self.conn.call_sync('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                                'RegisterStatusNotifierItem', V('(s)', (name,)), None, Gio.DBusCallFlags.NONE, 3000, None)
            return True
        except GLib.Error:
            self.stop()  # không có watcher (shell không hỗ trợ khay) hoặc lỗi D-Bus
            return False

    def stop(self):
        if self.conn:
            for i in self.ids:
                self.conn.unregister_object(i)
            if self.owner:
                Gio.bus_unown_name(self.owner)
        self.conn, self.ids, self.owner = None, [], 0

    # ---------- org.kde.StatusNotifierItem ----------
    def _sni_prop(self, _c, _s, _p, _i, prop):
        return {
            'Category': V('s', 'ApplicationStatus'), 'Id': V('s', 'vn.makeai.DiskCleaner'), 'Title': V('s', 'Disk Cleaner'),
            'Status': V('s', 'Active'), 'WindowId': V('i', 0), 'IconName': V('s', 'vn.makeai.DiskCleaner'),
            'IconThemePath': V('s', self.icon_dir), 'Menu': V('o', MENU_PATH), 'ItemIsMenu': V('b', False),
        }.get(prop)

    def _sni_call(self, _c, _s, _p, _i, method, _params, inv):
        if method in ('Activate', 'SecondaryActivate'):
            self.entries[1][1]()
        inv.return_value(None)

    # ---------- com.canonical.dbusmenu ----------
    def _props(self, iid):
        label, _fn = self.entries[iid]
        if label is None:
            return {'type': V('s', 'separator')}
        return {'label': V('s', label), 'enabled': V('b', True), 'visible': V('b', True)}

    def _menu_prop(self, _c, _s, _p, _i, prop):
        return {'Version': V('u', 3), 'TextDirection': V('s', 'ltr'), 'Status': V('s', 'normal'),
                'IconThemePath': V('as', [])}.get(prop)

    def _menu_call(self, _c, _s, _p, _i, method, params, inv):
        if method == 'GetLayout':
            parent = params.unpack()[0]
            if parent == 0:
                kids = [V('v', V('(ia{sv}av)', (i, self._props(i), []))) for i in self.entries]
                layout = (0, {'children-display': V('s', 'submenu')}, kids)
            else:
                layout = (parent, self._props(parent), [])
            inv.return_value(V('(u(ia{sv}av))', (1, layout)))
        elif method == 'GetGroupProperties':
            ids = params.unpack()[0] or list(self.entries)
            inv.return_value(V('(a(ia{sv}))', ([(i, self._props(i)) for i in ids if i in self.entries],)))
        elif method == 'GetProperty':
            iid, name = params.unpack()
            inv.return_value(V('(v)', (self._props(iid).get(name) or V('s', ''),)))
        elif method == 'Event':
            iid, event, _data, _ts = params.unpack()
            if event == 'clicked' and iid in self.entries and self.entries[iid][1]:
                self.entries[iid][1]()
            inv.return_value(None)
        elif method == 'EventGroup':
            for iid, event, _d, _t in params.unpack()[0]:
                if event == 'clicked' and iid in self.entries and self.entries[iid][1]:
                    self.entries[iid][1]()
            inv.return_value(V('(ai)', ([],)))
        elif method == 'AboutToShow':
            inv.return_value(V('(b)', (False,)))
        elif method == 'AboutToShowGroup':
            inv.return_value(V('(aiai)', ([], [])))
        else:
            inv.return_value(None)
