// SPDX-License-Identifier: MIT
//
// macOS Control Center — layout, backends and the arrange mode.
//
// Layout tree (every node carries a style class for CSS targeting):
//
//   .cc-menu                              (PopupMenu content box)
//   └── .macos-control-center             (St.BoxLayout, vertical)
//       ├── .cc-toggle-grid               Clutter.GridLayout, 4 cols x 4 rows
//       │   ├── .cc-pill.cc-wifi-pill              (0,0) span 2x1
//       │   ├── .cc-card.cc-media-card             (2,0) span 2x2
//       │   ├── .cc-pill.cc-bluetooth-pill         (0,1) span 2x1
//       │   ├── .cc-pill.cc-airdrop-pill           (0,2) span 2x1
//       │   ├── .cc-icon-button.cc-display-button  (2,2) span 1x1
//       │   ├── .cc-icon-button.cc-screenshot-button (3,2) span 1x1
//       │   ├── .cc-icon-button.cc-nightlight-button (0,3) span 1x1
//       │   ├── .cc-icon-button.cc-record-button   (1,3) span 1x1
//       │   └── .cc-pill.cc-focus-pill             (2,3) span 2x1
//       ├── .cc-custom-grid               Clutter.GridLayout, 4 cols, free rows
//       │   ├── adopted QuickToggle / QuickMenuToggle actors
//       │   └── .cc-edit-overlay          (arrange mode only, one per item)
//       ├── .cc-card.cc-slider-card       "Display" label + brightness slider
//       ├── .cc-card.cc-slider-card       "Sound" label + volume slider
//       └── .cc-bottom-bar                centered: Edit / + Add / Done
//
//   .cc-gallery                           (second view, swapped in place)
//   ├── .cc-gallery-header                back button + title
//   ├── .cc-gallery-hint
//   ├── .cc-gallery-scroll                St.ScrollView -> .cc-gallery-list
//   └── .cc-gallery-done
//
// Liquid Glass integration
// ------------------------
// The Liquid Glass extension (liquid-glass@thinkingcoding1231.gmail.com) finds
// every dropdown in Main.panel.statusArea whose menu is a real PopupMenu, adds
// `.liquid-glass-transparent` to menu.actor/menu.box and `.liquid-glass-menu-root`
// to menu.box, and draws one sheet of glass behind the box. Its stylesheet then
// forces every descendant StButton to a transparent background (`!important`).
//
// So the panel is built as a *glyph layer on a single sheet*: tiles carry only a
// faint fill, grouping comes from the icon circles (St.Bin, which the Liquid
// Glass rules do not touch) and from spacing, and nothing is nested glass-on-glass
// as Apple's Liquid Glass guidance requires. `_onMenuStyleChanged()` mirrors the
// presence of `.liquid-glass-menu-root` onto `.cc-glass-host`, which drops the
// remaining fills (the cards, which are St.BoxLayouts and therefore invisible to
// the Liquid Glass rules) so the result is one material, not two.
//
// IMPORTANT: St.BoxLayout has no `spacing` GObject property (verified against
// st-box-layout.c on 45 -> 51: it only ever exposed `orientation`, plus the
// removed `vertical`/`pack-start`). Spacing is read exclusively from the theme
// node via st_theme_node_get_length (node, "spacing") and re-applied on every
// style change, so it MUST be declared in stylesheet.css. Passing `spacing` to
// a constructor throws "No property spacing on StBoxLayout".

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const LOG_PREFIX = '[macos-control-center]';

// Gio.DBusConnection.call() is callback based; promisify it once so every
// helper below can be written as plain async/await.
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

// NetworkManager and BlueZ are SYSTEM bus services; MPRIS, the screencast
// service and the power plugin are session services. Getting this wrong is
// silent: the proxy simply never initialises and the toggle looks dead.
const NM_NAME = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_IFACE = 'org.freedesktop.NetworkManager';
const NM_CONNECTION_IFACE = 'org.freedesktop.NetworkManager.Connection.Active';

const BLUEZ_NAME = 'org.bluez';
const BLUEZ_PATH = '/';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const POWER_NAME = 'org.gnome.SettingsDaemon.Power';
const POWER_PATH = '/org/gnome/SettingsDaemon/Power';
const POWER_SCREEN_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

const SCREENCAST_NAME = 'org.gnome.Shell.Screencast';
const SCREENCAST_PATH = '/org/gnome/Shell/Screencast';
const SCREENCAST_IFACE = 'org.gnome.Shell.Screencast';

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';

const ADOPTED_TOGGLES_KEY = 'adopted-toggles';
const CUSTOM_LAYOUT_KEY = 'custom-layout';

// The custom grid. Items are placed in cells of a four-column grid, two columns
// wide and one row tall by default.
const CUSTOM_COLUMNS = 4;
const CUSTOM_SPACING = 10;
const DEFAULT_SPAN_W = 2;
const DEFAULT_SPAN_H = 1;

/* ------------------------------------------------------------------------ */
/* D-Bus helpers                                                            */
/* ------------------------------------------------------------------------ */

/**
 * @param {object} params
 * @param {Gio.DBusConnection} [params.bus] defaults to the session bus
 * @param {string} params.busName
 * @param {string} params.objectPath
 * @param {string} params.interfaceName
 * @param {(changed: GLib.Variant) => void} [params.onPropertiesChanged]
 * @returns {Gio.DBusProxy} an uninitialised proxy
 */
function createProxy({bus = Gio.DBus.session, busName, objectPath, interfaceName, onPropertiesChanged = null}) {
    const proxy = new Gio.DBusProxy({
        g_connection: bus,
        g_name: busName,
        g_object_path: objectPath,
        g_interface_name: interfaceName,
        g_flags: Gio.DBusProxyFlags.NONE,
    });

    // The handler captures the panel, so its id is kept on the proxy: without
    // an explicit disconnect a proxy that outlives disable() would keep the
    // whole widget tree alive. proxy.dispose() below is the counterpart.
    if (onPropertiesChanged) {
        proxy._ccPropertiesChangedId = proxy.connect('g-properties-changed',
            (_proxy, changed) => onPropertiesChanged(changed));
    }

    return proxy;
}

/** Detaches a proxy's handler so nothing keeps the panel reachable. */
function disposeProxy(proxy) {
    if (proxy?._ccPropertiesChangedId) {
        proxy.disconnect(proxy._ccPropertiesChangedId);
        proxy._ccPropertiesChangedId = 0;
    }
}

/**
 * Initialises a proxy and checks that something is really on the other end.
 *
 * `init_async()` only fails when the connection itself is broken: asking for a
 * well-known name nobody owns still "succeeds" and leaves a proxy whose every
 * property reads back null. That is exactly how a control ends up looking dead
 * (the service was simply on the other bus), so the name owner — not the init
 * result — decides whether a service counts as available.
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {Promise<boolean>} whether the service behind the proxy is there
 */
async function initProxy(proxy) {
    try {
        await proxy.init_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        console.warn(`${LOG_PREFIX} ${proxy.get_name()}${proxy.get_object_path()} unavailable: ${e.message}`);
        return false;
    }

    if (!proxy.g_name_owner) {
        const bus = proxy.get_connection() === Gio.DBus.system
            ? 'the system bus'
            : 'the session bus';
        console.warn(`${LOG_PREFIX} ${proxy.get_name()} has no owner on ${bus}`);
        return false;
    }

    return true;
}

/**
 * Writes a property through org.freedesktop.DBus.Properties, on whichever bus
 * the proxy was built for — never assume the session bus.
 *
 * @returns {Promise<boolean>} whether the property was written
 */
async function setDBusProperty(proxy, interfaceName, propertyName, value) {
    if (!proxy)
        return false;

    const connection = proxy.get_connection() ?? Gio.DBus.session;

    try {
        await connection.call(
            proxy.get_name(), proxy.get_object_path(), DBUS_PROPERTIES_IFACE, 'Set',
            new GLib.Variant('(ssv)', [interfaceName, propertyName, value]),
            null, Gio.DBusCallFlags.NONE, -1, null);
        return true;
    } catch (e) {
        console.warn(`${LOG_PREFIX} cannot set ${interfaceName}.${propertyName}: ${e.message}`);
        return false;
    }
}

function callDBusMethod(proxy, methodName, parameters = null) {
    if (!proxy)
        return;

    const connection = proxy.get_connection() ?? Gio.DBus.session;

    connection.call(
        proxy.get_name(), proxy.get_object_path(), proxy.get_interface_name(),
        methodName, parameters, null, Gio.DBusCallFlags.NONE, -1, null)
        .catch(e => console.warn(`${LOG_PREFIX} ${methodName}() failed: ${e.message}`));
}

/** @returns {boolean} whether two grid rectangles overlap */
function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* ------------------------------------------------------------------------ */
/* Reusable widgets                                                         */
/* ------------------------------------------------------------------------ */

/** Circular, icon-only button used for every small square in the grid. */
const CCIconButton = GObject.registerClass(
class CCIconButton extends St.Button {
    /**
     * @param {object} params
     * @param {string} params.iconName
     * @param {string} [params.styleClass]
     * @param {boolean} [params.toggleMode]
     * @param {string} [params.accessibleName]
     */
    _init({iconName, styleClass = '', toggleMode = false, accessibleName = ''}) {
        super._init({
            style_class: `cc-icon-button ${styleClass}`.trim(),
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: toggleMode,
            accessible_name: accessibleName,
            // Keep the circle centred (and circular) when the grid cell is
            // taller or wider than the button itself.
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._iconWidget = new St.Icon({
            icon_name: iconName,
            style_class: 'cc-icon-button-icon',
        });
        this.set_child(this._iconWidget);
    }

    /** @type {St.Icon} */
    get icon() {
        return this._iconWidget;
    }
});

/**
 * Wide tile: circular icon + title + optional subtitle and/or network chip.
 * Matches the Wi-Fi / Bluetooth / AirDrop / Focus modules of the reference.
 */
const CCPillButton = GObject.registerClass(
class CCPillButton extends St.Button {
    /**
     * @param {object} params
     * @param {string} params.iconName
     * @param {string} params.title
     * @param {string|null} [params.subtitle]
     * @param {string} [params.styleClass]
     * @param {boolean} [params.toggleMode]
     * @param {boolean} [params.hasChip] render a small network chip under the title
     */
    _init({iconName, title, subtitle = null, styleClass = '', toggleMode = false, hasChip = false}) {
        super._init({
            style_class: `cc-pill ${styleClass}`.trim(),
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: toggleMode,
            x_expand: true,
        });

        const content = new St.BoxLayout({
            style_class: 'cc-pill-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._iconCircle = new St.Bin({
            style_class: 'cc-pill-icon-circle',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'cc-pill-icon',
            }),
        });
        content.add_child(this._iconCircle);

        const textBox = new St.BoxLayout({
            style_class: 'cc-pill-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._titleLabel = new St.Label({
            text: title,
            style_class: 'cc-pill-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);

        this._subtitleLabel = null;
        if (subtitle !== null) {
            this._subtitleLabel = new St.Label({
                text: subtitle,
                style_class: 'cc-pill-subtitle',
                x_align: Clutter.ActorAlign.START,
            });
            this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(this._subtitleLabel);
        }

        // The reference shows a small rounded chip under "Wi-Fi" holding the
        // network name, or an empty placeholder when nothing is connected.
        this._chipLabel = null;
        this._chip = null;
        if (hasChip) {
            this._chipLabel = new St.Label({
                text: '',
                style_class: 'cc-pill-chip-label',
            });
            this._chipLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._chip = new St.Bin({
                style_class: 'cc-pill-chip',
                x_align: Clutter.ActorAlign.START,
                child: this._chipLabel,
            });
            textBox.add_child(this._chip);
        }

        content.add_child(textBox);
        this.set_child(content);
    }

    /** @type {St.Icon} */
    get icon() {
        return this._iconCircle.get_child();
    }

    /** @type {St.Label} */
    get titleLabel() {
        return this._titleLabel;
    }

    /** @type {St.Label|null} */
    get subtitleLabel() {
        return this._subtitleLabel;
    }

    /**
     * @param {string|null} text network name, or null for the empty placeholder
     */
    setChipText(text) {
        if (!this._chip)
            return;

        this._chipLabel.text = text ?? '';
        this._chipLabel.visible = Boolean(text);
    }
});

/** One "icon + St.Slider + icon" row, wrapped by a .cc-slider-card. */
const CCSliderRow = GObject.registerClass(
class CCSliderRow extends St.BoxLayout {
    /**
     * @param {object} params
     * @param {string} params.startIcon
     * @param {string} params.endIcon
     * @param {string} params.accessibleName
     */
    _init({startIcon, endIcon, accessibleName}) {
        super._init({
            style_class: 'cc-slider-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this.add_child(new St.Icon({
            icon_name: startIcon,
            style_class: 'cc-slider-icon cc-slider-icon-start',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.slider = new Slider(0);
        this.slider.accessible_name = accessibleName;

        this._sliderBin = new St.Bin({
            style_class: 'cc-slider-bin',
            child: this.slider,
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._sliderBin);

        this.add_child(new St.Icon({
            icon_name: endIcon,
            style_class: 'cc-slider-icon cc-slider-icon-end',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.slider.connectObject(
            'key-focus-in', () => this._sliderBin.add_style_pseudo_class('focus'),
            'key-focus-out', () => this._sliderBin.remove_style_pseudo_class('focus'),
            this);
    }
});

/** A single row of the "add controls" gallery. */
const CCGalleryRow = GObject.registerClass(
class CCGalleryRow extends St.Button {
    /**
     * @param {object} params
     * @param {string|null} params.iconName
     * @param {Gio.Icon|null} [params.gicon]
     * @param {string} params.title
     * @param {string|null} [params.subtitle]
     * @param {boolean} [params.available]
     */
    _init({iconName, gicon = null, title, subtitle = null, available = true}) {
        super._init({
            style_class: `cc-gallery-row${available ? '' : ' cc-gallery-row-unavailable'}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            toggle_mode: true,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-gallery-row-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        const iconProps = {
            style_class: 'cc-gallery-row-icon',
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (gicon)
            iconProps.gicon = gicon;
        else
            iconProps.icon_name = iconName ?? 'application-x-executable-symbolic';
        box.add_child(new St.Icon(iconProps));

        const textBox = new St.BoxLayout({
            style_class: 'cc-gallery-row-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        textBox.add_child(new St.Label({
            text: title,
            style_class: 'cc-gallery-row-title',
            x_align: Clutter.ActorAlign.START,
        }));
        if (subtitle) {
            textBox.add_child(new St.Label({
                text: subtitle,
                style_class: 'cc-gallery-row-subtitle',
                x_align: Clutter.ActorAlign.START,
            }));
        }
        box.add_child(textBox);

        this._check = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'cc-gallery-row-check',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._check);

        this.set_child(box);

        this.connect('notify::checked', () => {
            this._check.visible = this.checked;
        });
    }
});

/**
 * The frame a custom control is moved and resized with in arrange mode.
 *
 * This is a plain St.Widget on purpose: the Liquid Glass stylesheet forces every
 * StButton background to transparent, and a StButton frame would therefore
 * disappear on the glass sheet. Being a sibling placed over the real control it
 * also swallows the clicks, so arranging never toggles the control underneath.
 */
const CCEditOverlay = GObject.registerClass({
    Signals: {
        'move-request': {},
        'resize-request': {},
    },
}, class CCEditOverlay extends St.Widget {
    _init() {
        super._init({
            style_class: 'cc-edit-overlay',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            // BinLayout gives the grip the whole frame and honours its align.
            layout_manager: new Clutter.BinLayout(),
        });

        this._grip = new St.Widget({
            style_class: 'cc-edit-grip',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._grip);

        // The grip sits on top of the frame, so it wins the press and the
        // handler returning EVENT_STOP keeps it from starting a move.
        this._grip.connect('button-press-event', () => {
            this.emit('resize-request');
            return Clutter.EVENT_STOP;
        });

        this.connect('button-press-event', () => {
            this.emit('move-request');
            return Clutter.EVENT_STOP;
        });
    }
});

/* ------------------------------------------------------------------------ */
/* MPRIS                                                                    */
/* ------------------------------------------------------------------------ */

const MprisController = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class MprisController extends GObject.Object {
    _init() {
        super._init();

        this._proxy = null;
        this._busName = null;
        this._title = '';
        this._artist = '';
        this._artUrl = '';
        this._playing = false;

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [name] = params.deepUnpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this._selectPlayer();
            });
    }

    get title() {
        return this._title;
    }

    get artist() {
        return this._artist;
    }

    get artUrl() {
        return this._artUrl;
    }

    get playing() {
        return this._playing;
    }

    playPause() {
        callDBusMethod(this._proxy, 'PlayPause');
    }

    next() {
        callDBusMethod(this._proxy, 'Next');
    }

    previous() {
        callDBusMethod(this._proxy, 'Previous');
    }

    /** Pick the most suitable MPRIS player and attach to it. */
    async _selectPlayer() {
        let players = [];

        try {
            const reply = await Gio.DBus.session.call(
                DBUS_NAME, DBUS_PATH, DBUS_IFACE, 'ListNames',
                null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [names] = reply.deepUnpack();
            players = names.filter(name => name.startsWith(MPRIS_PREFIX));
        } catch (e) {
            console.warn(`${LOG_PREFIX} MPRIS lookup failed: ${e.message}`);
        }

        const busName = players.includes(this._busName)
            ? this._busName
            : players[0] ?? null;

        if (busName === this._busName && this._proxy)
            return;

        await this._attachPlayer(busName);
    }

    async _attachPlayer(busName) {
        this._proxy = null;
        this._busName = busName;

        if (!busName) {
            this._setState('', '', '', false);
            return;
        }

        const proxy = createProxy({
            busName,
            objectPath: MPRIS_PATH,
            interfaceName: MPRIS_PLAYER_IFACE,
            onPropertiesChanged: () => this._sync(),
        });

        if (!await initProxy(proxy))
            return;

        // A newer player may have won the race while we were awaiting.
        if (this._busName !== busName)
            return;

        this._proxy = proxy;
        this._sync();
    }

    _sync() {
        const metadata = this._proxy?.get_cached_property('Metadata');
        const playbackStatus =
            this._proxy?.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';

        let title = '';
        let artist = '';
        let artUrl = '';

        if (metadata) {
            const track = metadata.recursiveUnpack();
            title = track['xesam:title'] ?? '';
            artUrl = track['mpris:artUrl'] ?? '';

            const artists = track['xesam:artist'];
            if (Array.isArray(artists))
                artist = artists.join(', ');
            else if (typeof artists === 'string')
                artist = artists;
        }

        this._setState(title, artist, artUrl, playbackStatus === 'Playing');
    }

    _setState(title, artist, artUrl, playing) {
        if (this._title === title && this._artist === artist &&
            this._artUrl === artUrl && this._playing === playing)
            return;

        this._title = title;
        this._artist = artist;
        this._artUrl = artUrl;
        this._playing = playing;
        this.emit('changed');
    }

    destroy() {
        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = 0;
        }

        disposeProxy(this._proxy);
        this._proxy = null;
        this._busName = null;
    }
});

/* ------------------------------------------------------------------------ */
/* Panel                                                                    */
/* ------------------------------------------------------------------------ */

export class ControlCenterPanel extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    /** @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension */
    _init(extension) {
        super._init(0.0, extension.gettext('Control Center'));

        this._extension = extension;
        this._gettext = extension.gettext.bind(extension);

        this._settings = null;
        this._proxies = [];

        this._mpris = null;

        this._mixerControl = null;
        this._volumeStream = null;
        this._volumeSliderSyncing = false;

        this._brightnessManager = null;
        this._brightnessScale = null;
        this._brightnessProxy = null;
        this._brightnessSliderSyncing = false;

        this._wifiProxy = null;
        this._wifiConnectionProxy = null;
        this._wifiConnectionName = '';
        this._wifiReady = false;

        this._adapterProxy = null;
        this._bluetoothReady = false;
        this._bluezOwnerId = 0;

        this._recording = false;

        // Adopted Quick Settings items. `_desired` is the persisted wish-list
        // (titles), `_adopted` maps title -> live record while materialised and
        // `_layout` maps title -> {x, y, w, h} cell rectangle.
        this._desired = new Set();
        this._adopted = new Map();
        this._layout = new Map();
        this._galleryRows = [];

        // Arrange mode.
        this._editMode = false;
        this._overlays = new Map();
        this._builtInButtons = [];
        // Whether each built-in module is usable right now. Kept separate from
        // `reactive` so that leaving arrange mode cannot revive a control whose
        // backend never came up (a missing BlueZ adapter, say).
        this._builtInEnabled = new Map();
        this._drag = null;
        this._stageMotionId = 0;
        this._stageReleaseId = 0;

        this._initSettings();

        // ---- status area button -------------------------------------------
        this.add_style_class_name('cc-panel-button');
        this.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon cc-panel-icon',
        }));

        // ---- menu ---------------------------------------------------------
        this.menu.box.add_style_class_name('cc-menu');

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this._section.box.add_child(this._buildContent());
        this._section.box.add_child(this._buildGallery());

        this._setupGlassDetection();

        // ---- backends -----------------------------------------------------
        this._mpris = new MprisController();
        this._mpris.connectObject('changed', () => this._syncMediaCard(), this);

        this._initFocusMode();
        this._initNightLight();
        this._initVolume();
        this._initBrightness();
        this._initWifi();
        this._initBluetooth();

        this._syncMediaCard();
        this._syncRecordingButton();

        // Re-resolve the active MPRIS player, retry any backend that was not up
        // yet and pick up late-registering third-party toggles on every open.
        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            // The stage-level drag listeners must not outlive the popup.
            if (!isOpen) {
                this._endDrag();
                return;
            }

            this._mpris?._selectPlayer();

            if (!this._wifiReady)
                this._initWifi();
            // Always re-checked: BlueZ may have gained, lost or swapped an
            // adapter since the last open, and the call is a cheap round trip.
            this._initBluetooth();

            this._reconcileAdoptedToggles();
            if (this._gallery.visible)
                this._refreshGallery();
        }, this);
    }

    /* ---------------------------------------------------------------- layout */

    _buildContent() {
        this._content = new St.BoxLayout({
            style_class: 'macos-control-center',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._content.add_child(this._buildToggleGrid());
        this._content.add_child(this._buildCustomGrid());

        const brightness = this._buildSliderCard({
            title: this._gettext('Display'),
            // Adwaita only ships one brightness glyph; the "small sun / large
            // sun" pairing of the reference is done with icon-size in CSS.
            startIcon: 'display-brightness-symbolic',
            endIcon: 'display-brightness-symbolic',
            accessibleName: this._gettext('Display Brightness'),
        });
        this._brightnessRow = brightness.row;
        this._brightnessRow.slider.connect('notify::value',
            () => this._onBrightnessChanged());
        this._content.add_child(brightness.card);

        const sound = this._buildSliderCard({
            title: this._gettext('Sound'),
            startIcon: 'audio-volume-low-symbolic',
            endIcon: 'audio-volume-high-symbolic',
            accessibleName: this._gettext('Sound Volume'),
        });
        this._volumeRow = sound.row;
        this._volumeRow.slider.connect('notify::value',
            () => this._onVolumeChanged());
        this._content.add_child(sound.card);

        this._content.add_child(this._buildBottomBar());

        return this._content;
    }

    _buildToggleGrid() {
        this._toggleGrid = new St.Widget({
            style_class: 'cc-grid cc-toggle-grid',
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                // Homogeneous cells keep the round buttons perfectly circular,
                // split the panel into two equal halves and let the media card
                // spanning two rows stay square with the tiles beside it.
                column_homogeneous: true,
                row_homogeneous: true,
                column_spacing: CUSTOM_SPACING,
                row_spacing: CUSTOM_SPACING,
            }),
            x_expand: true,
        });
        const layout = this._toggleGrid.layout_manager;

        // --- row 0: Wi-Fi + media (media spans rows 0-1) --------------------
        this._wifiPill = new CCPillButton({
            iconName: 'network-wireless-symbolic',
            title: this._gettext('Wi-Fi'),
            styleClass: 'cc-wifi-pill',
            toggleMode: true,
            hasChip: true,
        });
        this._wifiPill.connect('clicked', () => this._onWifiClicked());
        layout.attach(this._wifiPill, 0, 0, 2, 1);

        layout.attach(this._buildMediaCard(), 2, 0, 2, 2);

        // --- row 1: Bluetooth ----------------------------------------------
        this._bluetoothPill = new CCPillButton({
            iconName: 'bluetooth-symbolic',
            title: this._gettext('Bluetooth'),
            subtitle: this._gettext('Off'),
            styleClass: 'cc-bluetooth-pill',
            toggleMode: true,
        });
        this._bluetoothPill.connect('clicked', () => this._onBluetoothClicked());
        layout.attach(this._bluetoothPill, 0, 1, 2, 1);

        // --- row 2: AirDrop + two round shortcuts ---------------------------
        this._airdropPill = new CCPillButton({
            iconName: 'network-wireless-hotspot-symbolic',
            title: this._gettext('AirDrop'),
            subtitle: this._gettext('Off'),
            styleClass: 'cc-airdrop-pill',
            toggleMode: true,
        });
        this._airdropPill.connect('clicked', () => this._onAirDropClicked());
        layout.attach(this._airdropPill, 0, 2, 2, 1);

        this._displayButton = new CCIconButton({
            iconName: 'video-display-symbolic',
            styleClass: 'cc-display-button',
            accessibleName: this._gettext('Display Settings'),
        });
        this._displayButton.connect('clicked', () => this._openSettingsPanel('display'));
        layout.attach(this._displayButton, 2, 2, 1, 1);

        this._screenshotButton = new CCIconButton({
            iconName: 'camera-photo-symbolic',
            styleClass: 'cc-screenshot-button',
            accessibleName: this._gettext('Screenshot'),
        });
        this._screenshotButton.connect('clicked', () => this._openScreenshotUI());
        layout.attach(this._screenshotButton, 3, 2, 1, 1);

        // --- row 3: Night Light + Screen Recording + Focus ------------------
        this._nightLightButton = new CCIconButton({
            iconName: 'night-light-symbolic',
            styleClass: 'cc-nightlight-button',
            toggleMode: true,
            accessibleName: this._gettext('Night Light'),
        });
        layout.attach(this._nightLightButton, 0, 3, 1, 1);

        this._recordButton = new CCIconButton({
            iconName: 'camera-video-symbolic',
            styleClass: 'cc-record-button',
            toggleMode: true,
            accessibleName: this._gettext('Screen Recording'),
        });
        this._recordButton.connect('clicked', () => this._onRecordClicked());
        layout.attach(this._recordButton, 1, 3, 1, 1);

        this._focusPill = new CCPillButton({
            iconName: 'preferences-system-notifications-symbolic',
            title: this._gettext('Focus'),
            styleClass: 'cc-focus-pill',
            toggleMode: true,
        });
        layout.attach(this._focusPill, 2, 3, 2, 1);

        // The built-in modules are not rearrangeable, so they are dimmed and
        // made inert while arranging.
        this._builtInButtons = [
            this._wifiPill, this._bluetoothPill, this._airdropPill, this._focusPill,
            this._displayButton, this._screenshotButton,
            this._nightLightButton, this._recordButton,
        ];

        return this._toggleGrid;
    }

    /** Grid that hosts toggles adopted from the Shell / other extensions. */
    _buildCustomGrid() {
        this._customGrid = new St.Widget({
            style_class: 'cc-grid cc-custom-grid',
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_homogeneous: true,
                row_homogeneous: true,
                column_spacing: CUSTOM_SPACING,
                row_spacing: CUSTOM_SPACING,
            }),
            x_expand: true,
            visible: false,
        });
        this._customLayout = this._customGrid.layout_manager;

        return this._customGrid;
    }

    _buildMediaCard() {
        const card = new St.BoxLayout({
            style_class: 'cc-card cc-media-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._mediaArtIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'cc-media-art-icon',
        });
        card.add_child(new St.Bin({
            style_class: 'cc-media-art',
            child: this._mediaArtIcon,
            x_align: Clutter.ActorAlign.START,
        }));

        const meta = new St.BoxLayout({
            style_class: 'cc-media-meta',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_expand: true,
        });

        this._mediaTitle = new St.Label({
            text: this._gettext('Not Playing'),
            style_class: 'cc-media-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(this._mediaTitle);

        this._mediaArtist = new St.Label({
            text: this._gettext('No media player'),
            style_class: 'cc-media-artist',
            x_align: Clutter.ActorAlign.START,
        });
        this._mediaArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(this._mediaArtist);
        card.add_child(meta);

        this._mediaControls = new St.BoxLayout({
            style_class: 'cc-media-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const previous = new CCIconButton({
            iconName: 'media-skip-backward-symbolic',
            styleClass: 'cc-media-button',
            accessibleName: this._gettext('Previous'),
        });
        previous.connect('clicked', () => this._mpris?.previous());
        this._mediaControls.add_child(previous);

        this._playPauseButton = new CCIconButton({
            iconName: 'media-playback-start-symbolic',
            styleClass: 'cc-media-button cc-media-button-primary',
            accessibleName: this._gettext('Play / Pause'),
        });
        this._playPauseButton.connect('clicked', () => this._mpris?.playPause());
        this._mediaControls.add_child(this._playPauseButton);

        const next = new CCIconButton({
            iconName: 'media-skip-forward-symbolic',
            styleClass: 'cc-media-button',
            accessibleName: this._gettext('Next'),
        });
        next.connect('clicked', () => this._mpris?.next());
        this._mediaControls.add_child(next);

        card.add_child(this._mediaControls);

        return card;
    }

    /**
     * @param {object} params
     * @param {string} params.title
     * @param {string} params.startIcon
     * @param {string} params.endIcon
     * @param {string} params.accessibleName
     * @returns {{card: St.BoxLayout, row: CCSliderRow}}
     */
    _buildSliderCard({title, startIcon, endIcon, accessibleName}) {
        const card = new St.BoxLayout({
            style_class: 'cc-card cc-slider-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        card.add_child(new St.Label({
            text: title,
            style_class: 'cc-slider-title',
            x_align: Clutter.ActorAlign.START,
        }));

        const row = new CCSliderRow({startIcon, endIcon, accessibleName});
        card.add_child(row);

        return {card, row};
    }

    /** Centered row holding Edit Controls / + Add Control / Done. */
    _buildBottomBar() {
        const bar = new St.BoxLayout({
            style_class: 'cc-bottom-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._editButton = new St.Button({
            style_class: 'cc-bottom-button cc-edit-controls-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: this._gettext('Edit Controls'),
        });
        const editBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        editBox.add_child(new St.Icon({
            icon_name: 'document-edit-symbolic',
            style_class: 'cc-edit-controls-icon',
        }));
        editBox.add_child(new St.Label({
            text: this._gettext('Edit Controls'),
            style_class: 'cc-edit-controls-label',
        }));
        this._editButton.set_child(editBox);
        this._editButton.connect('clicked', () => this._setEditMode(true));
        bar.add_child(this._editButton);

        this._addButton = new St.Button({
            style_class: 'cc-bottom-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            visible: false,
            accessible_name: this._gettext('Add Control'),
        });
        const addBox = new St.BoxLayout({
            style_class: 'cc-edit-controls-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        addBox.add_child(new St.Icon({
            icon_name: 'list-add-symbolic',
            style_class: 'cc-edit-controls-icon',
        }));
        addBox.add_child(new St.Label({
            text: this._gettext('Add Control'),
            style_class: 'cc-edit-controls-label',
        }));
        this._addButton.set_child(addBox);
        this._addButton.connect('clicked', () => this._showGallery());
        bar.add_child(this._addButton);

        this._doneButton = new St.Button({
            style_class: 'cc-bottom-button cc-bottom-done',
            can_focus: true,
            reactive: true,
            track_hover: true,
            visible: false,
            label: this._gettext('Done'),
        });
        this._doneButton.connect('clicked', () => this._setEditMode(false));
        bar.add_child(this._doneButton);

        return bar;
    }

    _buildGallery() {
        this._gallery = new St.BoxLayout({
            style_class: 'cc-gallery',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });

        const header = new St.BoxLayout({
            style_class: 'cc-gallery-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._galleryBack = new CCIconButton({
            iconName: 'go-previous-symbolic',
            styleClass: 'cc-gallery-back',
            accessibleName: this._gettext('Back'),
        });
        this._galleryBack.connect('clicked', () => this._hideGallery());
        header.add_child(this._galleryBack);

        header.add_child(new St.Label({
            text: this._gettext('Add Control'),
            style_class: 'cc-gallery-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._gallery.add_child(header);

        this._gallery.add_child(new St.Label({
            text: this._gettext('Switches come from GNOME Shell and other extensions. An added control leaves the standard Quick Settings until you remove it.'),
            style_class: 'cc-gallery-hint',
            x_align: Clutter.ActorAlign.START,
        }));

        this._galleryList = new St.BoxLayout({
            style_class: 'cc-gallery-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._gallery.add_child(new St.ScrollView({
            style_class: 'cc-gallery-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._galleryList,
            x_expand: true,
        }));

        this._galleryEmpty = new St.Label({
            text: this._gettext('No additional controls were found.'),
            style_class: 'cc-gallery-empty',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._gallery.add_child(this._galleryEmpty);

        const done = new St.Button({
            style_class: 'cc-gallery-done',
            can_focus: true,
            reactive: true,
            track_hover: true,
            label: this._gettext('Done'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        done.connect('clicked', () => this._hideGallery());
        this._gallery.add_child(done);

        return this._gallery;
    }

    /* -------------------------------------------------------- arrange mode */

    /**
     * Recomputes `reactive`/`can_focus`/the dimmed style of every built-in
     * module from its backend availability and the current mode. Single point
     * of truth, so a late backend cannot fight arrange mode (or the reverse).
     */
    _applyBuiltInState() {
        for (const button of this._builtInButtons) {
            const available = this._builtInEnabled.get(button) ?? true;
            const interactive = available && !this._editMode;

            button.reactive = interactive;
            button.can_focus = interactive;

            if (available)
                button.remove_style_class_name('cc-disabled');
            else
                button.add_style_class_name('cc-disabled');
        }
    }

    /**
     * Marks a built-in module as usable or not.
     * @param {St.Widget} button
     * @param {boolean} available
     */
    _setBuiltInAvailable(button, available) {
        this._builtInEnabled.set(button, available);
        this._applyBuiltInState();
    }

    /** @param {boolean} enabled */
    _setEditMode(enabled) {
        if (this._editMode === enabled)
            return;

        this._editMode = enabled;

        this._editButton.visible = !enabled;
        this._addButton.visible = enabled;
        this._doneButton.visible = enabled;

        this._content.add_style_class_name('cc-editing');
        if (!enabled)
            this._content.remove_style_class_name('cc-editing');

        // Built-in modules are fixed: dim them and take them out of the tab and
        // click order while arranging, so only the custom ones react.
        this._applyBuiltInState();
        this._toggleGrid.opacity = enabled ? 110 : 255;

        if (enabled)
            this._createEditOverlays();
        else
            this._destroyEditOverlays();

        if (!enabled)
            this._hideGallery();
    }

    /** @param {string} identifier */
    _ensureEditOverlay(identifier) {
        if (this._overlays.has(identifier) || !this._adopted.has(identifier))
            return;

        const overlay = new CCEditOverlay();
        overlay.connect('move-request', () => this._beginDrag(identifier, 'move'));
        overlay.connect('resize-request', () => this._beginDrag(identifier, 'resize'));

        this._overlays.set(identifier, overlay);
        this._placeChild(overlay, this._layout.get(identifier) ??
            {x: 0, y: 0, w: DEFAULT_SPAN_W, h: DEFAULT_SPAN_H});
    }

    _createEditOverlays() {
        for (const identifier of this._adopted.keys())
            this._ensureEditOverlay(identifier);

        this._relayoutCustomGrid();
    }

    _destroyEditOverlays() {
        this._endDrag();

        for (const overlay of this._overlays.values()) {
            overlay.get_parent()?.remove_child(overlay);
            overlay.destroy();
        }
        this._overlays.clear();
    }

    _showGallery() {
        this._refreshGallery();
        this._content.hide();
        this._gallery.show();
    }

    _hideGallery() {
        this._gallery.hide();
        this._content.show();
    }

    /**
     * Every QuickToggle / QuickMenuToggle the Shell currently exposes, minus
     * the ones this panel already provides as built-in tiles.
     * @returns {Array<QuickToggle|QuickMenuToggle>}
     */
    _collectAvailableToggles() {
        const grid = Main.panel.statusArea?.quickSettings?.menu?._grid ?? null;
        if (!grid)
            return [];

        const builtIn = new Set([
            this._gettext('Wi-Fi').toLowerCase(),
            this._gettext('Bluetooth').toLowerCase(),
            this._gettext('AirDrop').toLowerCase(),
            this._gettext('Focus').toLowerCase(),
        ]);

        return grid.get_children().filter(child => {
            if (!(child instanceof QuickToggle) && !(child instanceof QuickMenuToggle))
                return false;

            return !builtIn.has((child.title ?? '').toLowerCase());
        });
    }

    /**
     * The handle used for persistence. Quick settings toggles only expose
     * `title`, and their `icon-name` is regularly empty because they use a
     * `gicon` instead, so the icon is used as the next best fallback — without
     * it every gicon-only toggle would collapse onto the same identifier.
     *
     * @returns {string}
     */
    _identifierFor(item) {
        return item.title || item.icon_name ||
            item.gicon?.to_string() || item.constructor.name;
    }

    _refreshGallery() {
        this._galleryList.destroy_all_children();
        this._galleryRows = [];

        // identifier -> {item, available}. Adopted items have left the Shell's
        // grid, so they are merged back in from our own bookkeeping.
        const candidates = new Map();

        for (const item of this._collectAvailableToggles())
            candidates.set(this._identifierFor(item), {item, available: true});

        for (const [identifier, record] of this._adopted)
            candidates.set(identifier, {item: record.item, available: true});

        // Entries that are stored but whose owner is not loaded right now
        // (e.g. the extension is disabled) stay visible and removable.
        for (const identifier of this._desired) {
            if (!candidates.has(identifier))
                candidates.set(identifier, {item: null, available: false});
        }

        for (const [identifier, {item, available}] of candidates) {
            const row = new CCGalleryRow({
                iconName: item?.icon_name ?? (available ? null : 'dialog-question-symbolic'),
                gicon: item?.gicon ?? null,
                title: identifier,
                subtitle: item?.subtitle ??
                    (available ? null : this._gettext('Not available right now')),
                available,
            });
            row.checked = this._desired.has(identifier);
            row.connect('clicked', () => this._onGalleryRowToggled(item, identifier, row.checked));

            this._galleryList.add_child(row);
            this._galleryRows.push({identifier, row, item});
        }

        this._galleryEmpty.visible = this._galleryRows.length === 0;
    }

    _onGalleryRowToggled(item, identifier, shouldAdopt) {
        if (shouldAdopt) {
            this._desired.add(identifier);
            if (item)
                this._adopt(item, identifier);
        } else {
            this._desired.delete(identifier);
            this._detachAdopted(identifier);
        }

        this._saveAdopted();
        this._relayoutCustomGrid();
        this._saveLayout();
    }

    /* ------------------------------------------------------------ adoption */

    /**
     * Moves a live Shell toggle into our custom grid.
     *
     * Clutter refuses to reparent an actor that still has a parent, so the
     * actor is detached first; Clutter.GridLayout.attach() then re-adds it.
     * The original parent, index and column span are kept so the item can be
     * handed back to the Shell untouched.
     *
     * @param {QuickToggle|QuickMenuToggle} item
     * @param {string} identifier
     */
    _adopt(item, identifier) {
        if (this._adopted.has(identifier))
            return;

        const parent = item.get_parent();
        let index = -1;
        let span = 1;

        if (parent) {
            index = parent.get_children().indexOf(item);
            try {
                span = parent.layout_manager?.child_get_property(parent, item, 'column-span') ?? 1;
            } catch {
                span = 1;
            }
        }

        // A QuickMenuToggle's popup lives in the Shell's own overlay, which is
        // invisible while our menu is open, so hide its submenu affordance.
        let menuEnabled = null;
        if (item instanceof QuickMenuToggle) {
            menuEnabled = item.menuEnabled;
            item.menuEnabled = false;
        }

        this._adopted.set(identifier, {item, parent, index, span, menuEnabled});

        if (!this._layout.has(identifier))
            this._layout.set(identifier, this._nextFreeRect());

        item.connectObject('destroy', () => this._onAdoptedItemDestroyed(identifier), this);

        try {
            this._relayoutCustomGrid();
            // A control added from the gallery while the panel is already in
            // arrange mode has to be rearrangeable straight away.
            if (this._editMode)
                this._ensureEditOverlay(identifier);
        } catch (e) {
            // Private Shell API — never let a failed adoption wedge the panel.
            console.warn(`${LOG_PREFIX} cannot adopt "${identifier}": ${e.message}`);
            this._detachAdopted(identifier);
        }
    }

    /** @param {string} identifier */
    _detachAdopted(identifier) {
        const record = this._adopted.get(identifier);
        if (!record)
            return;

        this._adopted.delete(identifier);
        this._removeEditOverlay(identifier);

        const {item, parent, index, span, menuEnabled} = record;
        item.disconnectObject(this);

        const currentParent = item.get_parent();
        if (currentParent)
            currentParent.remove_child(item);

        if (menuEnabled !== null)
            item.menuEnabled = menuEnabled;

        if (parent) {
            try {
                const at = Math.max(0, Math.min(index, parent.get_n_children()));
                parent.insert_child_at_index(item, at);

                if (span > 1) {
                    parent.layout_manager?.child_set_property(parent, item, 'column-span', span);
                }
            } catch (e) {
                // The original container may be gone (menu rebuild, extension
                // reload); the toggle simply stays detached.
                console.warn(`${LOG_PREFIX} cannot restore "${identifier}": ${e.message}`);
            }
        }

        this._layout.delete(identifier);
        this._relayoutCustomGrid();
    }

    _removeEditOverlay(identifier) {
        const overlay = this._overlays.get(identifier);
        if (!overlay)
            return;

        this._overlays.delete(identifier);
        overlay.get_parent()?.remove_child(overlay);
        overlay.destroy();
    }

    _onAdoptedItemDestroyed(identifier) {
        if (!this._adopted.has(identifier))
            return;

        this._adopted.delete(identifier);
        this._removeEditOverlay(identifier);
        this._relayoutCustomGrid();
    }

    /** Re-materialise persisted adoptions (extensions may load after us). */
    _reconcileAdoptedToggles() {
        if (this._desired.size === 0)
            return;

        const available = this._collectAvailableToggles();

        for (const identifier of this._desired) {
            if (this._adopted.has(identifier))
                continue;

            const item = available.find(candidate => this._identifierFor(candidate) === identifier);
            if (item)
                this._adopt(item, identifier);   // re-lays out the custom grid
        }
    }

    /* -------------------------------------------------------- custom layout */

    /**
     * The rectangles of the controls that are actually on screen right now.
     * Saved entries whose owner has not loaded (a disabled extension, say) still
     * reserve their cell for the next session but must not push live controls
     * around in this one.
     *
     * @returns {Array<{x: number, y: number, w: number, h: number}>}
     */
    _liveRects() {
        const rects = [];
        for (const identifier of this._adopted.keys()) {
            const rect = this._layout.get(identifier);
            if (rect)
                rects.push(rect);
        }
        return rects;
    }

    _nextFreeRect() {
        return this._firstFreeSlot(this._liveRects(), DEFAULT_SPAN_W, DEFAULT_SPAN_H);
    }

    /**
     * @param {Array<{x: number, y: number, w: number, h: number}>} occupied
     * @returns {{x: number, y: number, w: number, h: number}} first free slot
     */
    _firstFreeSlot(occupied, w, h) {
        for (let y = 0; y < 256; y++) {
            for (let x = 0; x + w <= CUSTOM_COLUMNS; x++) {
                const rect = {x, y, w, h};
                if (!occupied.some(other => rectsOverlap(rect, other)))
                    return rect;
            }
        }

        return {x: 0, y: 0, w, h};
    }

    /**
     * Pushes items that overlap another one into the first free slot. The item
     * the user just placed wins its cell, so dragging A onto B moves B.
     *
     * @param {string} [priority] identifier to keep in place
     */
    _resolveCollisions(priority = null) {
        const order = [...this._adopted.keys()].filter(id => this._layout.has(id));
        if (priority && order.includes(priority)) {
            order.splice(order.indexOf(priority), 1);
            order.unshift(priority);
        }

        const occupied = [];

        for (const identifier of order) {
            const rect = this._layout.get(identifier);
            if (!occupied.some(other => rectsOverlap(rect, other))) {
                occupied.push(rect);
                continue;
            }

            const free = this._firstFreeSlot(occupied, rect.w, rect.h);
            rect.x = free.x;
            rect.y = free.y;
            occupied.push(rect);
        }
    }

    /** Number of rows the custom grid currently needs. */
    _rowCount() {
        let rows = 1;
        for (const rect of this._liveRects())
            rows = Math.max(rows, rect.y + rect.h);
        return rows;
    }

    /** Re-places every adopted control (and its edit overlay) in its cell. */
    _relayoutCustomGrid() {
        this._resolveCollisions();

        for (const [identifier, record] of this._adopted) {
            const rect = this._layout.get(identifier);
            if (!rect)
                continue;

            this._placeChild(record.item, rect);

            const overlay = this._overlays.get(identifier);
            if (overlay)
                this._placeChild(overlay, rect);
        }

        this._customGrid.visible = this._adopted.size > 0;
    }

    /**
     * Puts an actor in a grid cell, preserving child order (and therefore the
     * overlays' place on top) when it is already parented.
     *
     * @param {Clutter.Actor} actor
     * @param {{x: number, y: number, w: number, h: number}} rect
     */
    _placeChild(actor, rect) {
        if (actor.get_parent() === this._customGrid) {
            this._customLayout.child_set_property(this._customGrid, actor, 'left-attach', rect.x);
            this._customLayout.child_set_property(this._customGrid, actor, 'top-attach', rect.y);
            this._customLayout.child_set_property(this._customGrid, actor, 'width', rect.w);
            this._customLayout.child_set_property(this._customGrid, actor, 'height', rect.h);
            return;
        }

        // clutter_actor_add_child() warns when the actor still has a parent, and
        // GridLayout.attach() ends in exactly that call.
        actor.get_parent()?.remove_child(actor);
        this._customLayout.attach(actor, rect.x, rect.y, rect.w, rect.h);
    }

    /* --------------------------------------------------------------- drag */

    /**
     * @param {string} identifier
     * @param {'move'|'resize'} mode
     */
    _beginDrag(identifier, mode) {
        const rect = this._layout.get(identifier);
        if (!rect || !this._adopted.has(identifier) || this._drag)
            return;

        const event = Clutter.get_current_event();
        const point = event ? this._gridPoint(event) : null;
        if (!point)
            return;

        const cell = this._cellAt(point.x, point.y);

        this._drag = {
            identifier,
            mode,
            rect,
            origin: {...rect},
            // Remember which cell was grabbed so the item keeps its offset
            // under the pointer instead of snapping its corner to it.
            grabCol: cell.col,
            grabRow: cell.row,
        };

        this._customGrid.add_style_class_name('cc-dragging');
        this._stageMotionId = global.stage.connect('motion-event', (_actor, motionEvent) => {
            this._onDragMotion(motionEvent);
            return Clutter.EVENT_PROPAGATE;
        });
        this._stageReleaseId = global.stage.connect('button-release-event', () => {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _onDragMotion(event) {
        const drag = this._drag;
        if (!drag)
            return;

        const point = this._gridPoint(event);
        if (!point)
            return;

        const cell = this._cellAt(point.x, point.y);

        if (drag.mode === 'move') {
            drag.rect.x = Math.clamp(drag.origin.x + cell.col - drag.grabCol, 0,
                CUSTOM_COLUMNS - drag.rect.w);
            drag.rect.y = Math.max(0, drag.origin.y + cell.row - drag.grabRow);
        } else {
            drag.rect.w = Math.clamp(cell.col - drag.rect.x + 1, 1,
                CUSTOM_COLUMNS - drag.rect.x);
            drag.rect.h = Math.max(1, cell.row - drag.rect.y + 1);
        }

        const record = this._adopted.get(drag.identifier);
        if (record)
            this._placeChild(record.item, drag.rect);

        const overlay = this._overlays.get(drag.identifier);
        if (overlay)
            this._placeChild(overlay, drag.rect);
    }

    _endDrag() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = 0;
        }
        if (this._stageReleaseId) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = 0;
        }

        const drag = this._drag;
        this._drag = null;
        this._customGrid.remove_style_class_name('cc-dragging');

        if (!drag)
            return;

        this._resolveCollisions(drag.identifier);
        this._relayoutCustomGrid();
        this._saveLayout();
    }

    /**
     * Stage point -> custom grid coordinates.
     * @returns {{x: number, y: number}|null}
     */
    _gridPoint(event) {
        const [x, y] = event.get_coords();
        const [ok, localX, localY] = this._customGrid.transform_stage_point(x, y);
        return ok ? {x: localX, y: localY} : null;
    }

    /** @returns {{col: number, row: number}} cell under a grid-local point */
    _cellAt(x, y) {
        const width = this._customGrid.get_width();
        const height = this._customGrid.get_height();
        const rows = this._rowCount();

        const cellW = Math.max(1, (width - (CUSTOM_COLUMNS - 1) * CUSTOM_SPACING) / CUSTOM_COLUMNS);
        const cellH = Math.max(1, (height - (rows - 1) * CUSTOM_SPACING) / rows);

        return {
            col: Math.clamp(Math.floor(x / (cellW + CUSTOM_SPACING)), 0, CUSTOM_COLUMNS - 1),
            row: Math.max(0, Math.floor(y / (cellH + CUSTOM_SPACING))),
        };
    }

    /* ---------------------------------------------------------- persistence */

    _initSettings() {
        try {
            this._settings = this._extension.getSettings();
            this._desired = new Set(this._settings.get_strv(ADOPTED_TOGGLES_KEY));
            this._layout = this._loadLayout();
        } catch (e) {
            // No schema installed (e.g. running straight from a checkout):
            // the picker still works, it just does not survive a restart.
            console.warn(`${LOG_PREFIX} settings unavailable, adoptions will not persist: ${e.message}`);
            this._settings = null;
        }
    }

    /** @returns {Map<string, {x: number, y: number, w: number, h: number}>} */
    _loadLayout() {
        const layout = new Map();
        if (!this._settings)
            return layout;

        for (const raw of this._settings.get_strv(CUSTOM_LAYOUT_KEY)) {
            try {
                const entry = JSON.parse(raw);
                if (typeof entry?.t !== 'string')
                    continue;

                layout.set(entry.t, {
                    x: Math.max(0, entry.x | 0),
                    y: Math.max(0, entry.y | 0),
                    w: Math.clamp(entry.w | 0 || DEFAULT_SPAN_W, 1, CUSTOM_COLUMNS),
                    h: Math.max(1, entry.h | 0 || DEFAULT_SPAN_H),
                });
            } catch {
                // Ignore malformed entries rather than dropping the whole list.
            }
        }

        return layout;
    }

    _saveAdopted() {
        if (!this._settings)
            return;

        this._settings.set_strv(ADOPTED_TOGGLES_KEY, [...this._desired]);
    }

    _saveLayout() {
        if (!this._settings)
            return;

        const entries = [];
        for (const [identifier, rect] of this._layout) {
            // Prune entries whose control was removed.
            if (!this._desired.has(identifier))
                continue;

            entries.push(JSON.stringify({
                t: identifier, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
            }));
        }

        this._settings.set_strv(CUSTOM_LAYOUT_KEY, entries);
    }

    /* -------------------------------------------------------- liquid glass */

    /**
     * The Liquid Glass extension marks the menus it covers with
     * `.liquid-glass-menu-root`; mirror that onto `.cc-glass-host` so the
     * stylesheet can drop the last of our own fills and leave exactly one
     * material behind. No hard dependency: if the extension is not installed
     * the class never appears and the standalone look is used.
     */
    _setupGlassDetection() {
        this._syncGlassHost();
        this.menu.box.connectObject('notify::style-class',
            () => this._syncGlassHost(), this);
    }

    _syncGlassHost() {
        const hosted = this.menu.box.has_style_class_name('liquid-glass-menu-root');
        const marked = this.menu.box.has_style_class_name('cc-glass-host');

        if (hosted && !marked)
            this.menu.box.add_style_class_name('cc-glass-host');
        else if (!hosted && marked)
            this.menu.box.remove_style_class_name('cc-glass-host');
    }

    /* -------------------------------------------------------------- wifi */

    async _initWifi() {
        if (this._wifiProxy)
            return;

        // NetworkManager lives on the SYSTEM bus.
        this._wifiProxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: NM_PATH,
            interfaceName: NM_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('WirelessEnabled', null))
                    this._syncWifiPill();
                if (changed.lookup_value('PrimaryConnection', null))
                    this._syncWifiConnection();
            },
        });
        this._proxies.push(this._wifiProxy);

        if (!await initProxy(this._wifiProxy)) {
            this._wifiProxy = null;
            this._wifiReady = false;
            this._setBuiltInAvailable(this._wifiPill, false);
            return;
        }

        this._wifiReady = true;
        this._setBuiltInAvailable(this._wifiPill, true);

        this._syncWifiPill();
        await this._syncWifiConnection();
    }

    _syncWifiPill() {
        const enabled =
            this._wifiProxy?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connected = enabled && Boolean(this._wifiConnectionName);

        this._wifiPill.checked = enabled;

        // Blue glyph only while actually associated, like the reference.
        if (connected)
            this._wifiPill.add_style_class_name('cc-connected');
        else
            this._wifiPill.remove_style_class_name('cc-connected');

        this._wifiPill.setChipText(connected ? this._wifiConnectionName : null);
    }

    async _syncWifiConnection() {
        this._disposeWifiConnectionProxy();
        this._wifiConnectionName = '';

        const path = this._wifiProxy?.get_cached_property('PrimaryConnection')?.unpack();
        if (!path || path === '/') {
            this._syncWifiPill();
            return;
        }

        const proxy = createProxy({
            bus: Gio.DBus.system,
            busName: NM_NAME,
            objectPath: path,
            interfaceName: NM_CONNECTION_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Id', null) && this._wifiConnectionProxy === proxy)
                    this._setWifiConnectionName(proxy);
            },
        });

        this._proxies.push(proxy);
        this._wifiConnectionProxy = proxy;

        if (!await initProxy(proxy) || this._wifiConnectionProxy !== proxy)
            return;

        this._setWifiConnectionName(proxy);
    }

    _disposeWifiConnectionProxy() {
        const proxy = this._wifiConnectionProxy;
        this._wifiConnectionProxy = null;

        if (!proxy)
            return;

        const index = this._proxies.indexOf(proxy);
        if (index !== -1)
            this._proxies.splice(index, 1);

        disposeProxy(proxy);
    }

    _setWifiConnectionName(proxy) {
        const type = proxy.get_cached_property('Type')?.unpack() ?? '';
        const isWireless = type === '802-11-wireless';

        // Only show a network name when the primary connection really is Wi-Fi
        // (on a wired machine the primary connection is the Ethernet one).
        this._wifiConnectionName =
            isWireless ? proxy.get_cached_property('Id')?.unpack() ?? '' : '';

        this._syncWifiPill();
    }

    _onWifiClicked() {
        setDBusProperty(this._wifiProxy, NM_IFACE, 'WirelessEnabled',
            new GLib.Variant('b', this._wifiPill.checked));
    }

    /* --------------------------------------------------------- bluetooth */

    /** @returns {Promise<string|null>} object path of the first BlueZ adapter */
    async _findAdapterPath() {
        try {
            const reply = await Gio.DBus.system.call(
                BLUEZ_NAME, BLUEZ_PATH, OBJECT_MANAGER_IFACE, 'GetManagedObjects',
                null, new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, null);
            const [objects] = reply.deepUnpack();

            return Object.keys(objects)
                .find(path => BLUEZ_ADAPTER_IFACE in objects[path]) ?? null;
        } catch (e) {
            console.warn(`${LOG_PREFIX} BlueZ unavailable: ${e.message}`);
            return null;
        }
    }

    async _initBluetooth() {
        // bluetoothd comes and goes; re-arm when it (re)appears.
        if (!this._bluezOwnerId) {
            this._bluezOwnerId = Gio.DBus.system.signal_subscribe(
                DBUS_NAME, DBUS_IFACE, 'NameOwnerChanged', DBUS_PATH, BLUEZ_NAME,
                Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _iface, _signal, params) => {
                    const [, , newOwner] = params.deepUnpack();
                    if (newOwner) {
                        this._adapterProxy = null;
                        this._bluetoothReady = false;
                        this._initBluetooth();
                    }
                });
        }

        const adapterPath = await this._findAdapterPath();

        if (!adapterPath) {
            this._adapterProxy = null;
            this._bluetoothReady = false;
            this._disableBluetoothButtons();
            return;
        }

        // Called on every menu open, so bail out when the adapter we are
        // already watching is still the right one: a dongle plugged in (or
        // swapped) since the last open has a different path and is picked up.
        if (this._adapterProxy?.get_object_path() === adapterPath) {
            this._bluetoothReady = true;
            this._syncBluetoothButtons();
            return;
        }

        // BlueZ lives on the SYSTEM bus too.
        this._adapterProxy = createProxy({
            bus: Gio.DBus.system,
            busName: BLUEZ_NAME,
            objectPath: adapterPath,
            interfaceName: BLUEZ_ADAPTER_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Powered', null) ||
                    changed.lookup_value('Discoverable', null))
                    this._syncBluetoothButtons();
            },
        });
        this._proxies.push(this._adapterProxy);

        if (!await initProxy(this._adapterProxy)) {
            this._adapterProxy = null;
            this._bluetoothReady = false;
            this._disableBluetoothButtons();
            return;
        }

        this._bluetoothReady = true;
        this._syncBluetoothButtons();
    }

    _disableBluetoothButtons() {
        this._builtInEnabled.set(this._bluetoothPill, false);
        this._builtInEnabled.set(this._airdropPill, false);
        this._applyBuiltInState();
    }

    _syncBluetoothButtons() {
        const powered = this._adapterProxy?.get_cached_property('Powered')?.unpack() ?? false;
        const discoverable =
            this._adapterProxy?.get_cached_property('Discoverable')?.unpack() ?? false;

        this._bluetoothPill.checked = powered;
        this._bluetoothPill.subtitleLabel.text =
            powered ? this._gettext('On') : this._gettext('Off');

        // "AirDrop" mirrors BlueZ discoverability: visible to nearby devices.
        this._airdropPill.checked = powered && discoverable;
        this._airdropPill.subtitleLabel.text = powered && discoverable
            ? this._gettext('Contacts Only')
            : this._gettext('Off');

        this._builtInEnabled.set(this._bluetoothPill, true);
        // Discoverability is meaningless while the adapter is off.
        this._builtInEnabled.set(this._airdropPill, powered);
        this._applyBuiltInState();
    }

    async _onBluetoothClicked() {
        const powered = this._bluetoothPill.checked;

        // BlueZ refuses to power the adapter off while it is discoverable, so
        // the two writes have to be serialised.
        if (!powered) {
            await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Discoverable',
                new GLib.Variant('b', false));
        }

        await setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Powered',
            new GLib.Variant('b', powered));
    }

    _onAirDropClicked() {
        setDBusProperty(this._adapterProxy, BLUEZ_ADAPTER_IFACE, 'Discoverable',
            new GLib.Variant('b', this._airdropPill.checked));
    }

    /* ------------------------------------------------------- focus / DND */

    _initFocusMode() {
        this._notificationsSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
        this._notificationsSettings.bind('show-banners', this._focusPill, 'checked',
            Gio.SettingsBindFlags.DEFAULT | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._focusPill.connectObject('notify::checked',
            () => this._syncFocusPill(), this);
        this._syncFocusPill();
    }

    _syncFocusPill() {
        this._focusPill.icon.icon_name = this._focusPill.checked
            ? 'notifications-disabled-symbolic'
            : 'preferences-system-notifications-symbolic';
    }

    /* --------------------------------------------------------- night light */

    _initNightLight() {
        this._colorSettings = new Gio.Settings({schema_id: COLOR_SCHEMA});
        this._colorSettings.bind('night-light-enabled', this._nightLightButton,
            'checked', Gio.SettingsBindFlags.DEFAULT);
    }

    /* --------------------------------------------------------------- volume */

    _initVolume() {
        this._mixerControl = new Gvc.MixerControl({name: 'macOS Control Center'});
        this._mixerControl.connectObject(
            'state-changed', () => this._syncVolume(),
            'default-sink-changed', () => this._syncVolume(),
            this);
        this._mixerControl.open();

        this._syncVolume();
    }

    _syncVolume() {
        const stream = this._mixerControl?.get_default_sink() ?? null;

        if (this._volumeStream !== stream) {
            this._volumeStream?.disconnectObject(this);
            this._volumeStream = stream;
            stream?.connectObject(
                'notify::volume', () => this._updateVolumeSlider(),
                'notify::is-muted', () => this._updateVolumeSlider(),
                this);
        }

        this._updateVolumeSlider();
    }

    _updateVolumeSlider() {
        const stream = this._volumeStream;
        if (!stream || !this._mixerControl)
            return;

        const maxVolume = this._mixerControl.get_vol_max_norm();
        const value = stream.is_muted ? 0 : Math.clamp(stream.volume / maxVolume, 0, 1);

        this._volumeSliderSyncing = true;
        this._volumeRow.slider.value = value;
        this._volumeSliderSyncing = false;
    }

    _onVolumeChanged() {
        if (this._volumeSliderSyncing || !this._volumeStream || !this._mixerControl)
            return;

        const {value} = this._volumeRow.slider;
        const maxVolume = this._mixerControl.get_vol_max_norm();

        if (value === 0) {
            this._volumeStream.change_is_muted(true);
        } else {
            if (this._volumeStream.is_muted)
                this._volumeStream.change_is_muted(false);
            this._volumeStream.set_volume(Math.round(value * maxVolume));
        }

        this._volumeStream.push_volume();
    }

    /* ----------------------------------------------------------- brightness */

    _initBrightness() {
        // GNOME 49+ manages brightness in the Shell itself.
        this._brightnessManager = Main.brightnessManager ?? null;

        if (this._brightnessManager) {
            this._brightnessManager.connectObject('changed',
                () => this._syncBrightness(), this);
            this._syncBrightness();
            return;
        }

        // Fallback for older shells: the power plugin owns the screen backlight.
        this._brightnessProxy = createProxy({
            busName: POWER_NAME,
            objectPath: POWER_PATH,
            interfaceName: POWER_SCREEN_IFACE,
            onPropertiesChanged: changed => {
                if (changed.lookup_value('Brightness', null))
                    this._updateBrightnessSlider();
            },
        });
        this._proxies.push(this._brightnessProxy);

        initProxy(this._brightnessProxy).then(available => {
            if (!available) {
                this._brightnessProxy = null;
                this._brightnessRow.hide();
                return;
            }

            this._updateBrightnessSlider();
        });
    }

    _syncBrightness() {
        const scale = this._brightnessManager?.globalScale ?? null;

        if (this._brightnessScale !== scale) {
            this._brightnessScale?.disconnectObject(this);
            this._brightnessScale = scale;
            scale?.connectObject('notify::value',
                () => this._updateBrightnessSlider(), this);
        }

        this._brightnessRow.visible = scale !== null;
        this._updateBrightnessSlider();
    }

    _updateBrightnessSlider() {
        let value = null;

        if (this._brightnessScale)
            value = this._brightnessScale.value;
        else if (this._brightnessProxy)
            value = (this._brightnessProxy.get_cached_property('Brightness')?.unpack() ?? 0) / 100;

        if (value === null) {
            this._brightnessRow.hide();
            return;
        }

        this._brightnessSliderSyncing = true;
        this._brightnessRow.slider.value = Math.clamp(value, 0, 1);
        this._brightnessSliderSyncing = false;
    }

    _onBrightnessChanged() {
        if (this._brightnessSliderSyncing)
            return;

        const {value} = this._brightnessRow.slider;

        if (this._brightnessScale)
            this._brightnessScale.value = value;
        else if (this._brightnessProxy)
            setDBusProperty(this._brightnessProxy, POWER_SCREEN_IFACE, 'Brightness',
                new GLib.Variant('i', Math.round(value * 100)));
    }

    /* ---------------------------------------------------------------- media */

    _syncMediaCard() {
        if (!this._mpris)
            return;

        const {title, artist, artUrl, playing} = this._mpris;

        this._mediaTitle.text = title || this._gettext('Not Playing');
        this._mediaArtist.text = artist || this._gettext('No media player');

        // Album art placeholder; only local artwork can be loaded through Gio.
        if (artUrl.startsWith('file://')) {
            this._mediaArtIcon.gicon = Gio.icon_new_for_string(artUrl);
        } else {
            this._mediaArtIcon.gicon = null;
            this._mediaArtIcon.icon_name = 'audio-x-generic-symbolic';
        }

        this._playPauseButton.icon.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        // Dim the transport row while there is nothing to control.
        if (title || artist)
            this._mediaControls.remove_style_class_name('cc-inactive');
        else
            this._mediaControls.add_style_class_name('cc-inactive');
    }

    /* ------------------------------------------------------------ utilities */

    /**
     * @param {string} panel a gnome-control-center panel id (e.g. "display")
     */
    _openSettingsPanel(panel) {
        this.menu.close();

        if (!Util.trySpawn(['gnome-control-center', panel]))
            console.warn(`${LOG_PREFIX} could not launch gnome-control-center ${panel}`);
    }

    _openScreenshotUI() {
        this.menu.close();

        // open() returns a promise; if screenshotUI is not up yet the optional
        // chain short-circuits and nothing is called at all.
        Main.screenshotUI?.open()
            .catch(e => console.warn(`${LOG_PREFIX} screenshot UI unavailable: ${e.message}`));
    }

    /* --------------------------------------------------------- screencast */

    _syncRecordingButton() {
        this._recordButton.checked = this._recording;
        if (this._recording)
            this._recordButton.add_style_class_name('cc-recording');
        else
            this._recordButton.remove_style_class_name('cc-recording');
    }

    _onRecordClicked() {
        if (this._recordButton.checked)
            this._startRecording();
        else
            this._stopRecording();
    }

    async _startRecording() {
        const directory =
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
            GLib.get_home_dir();
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const template = GLib.build_filenamev([directory, `Screencast from ${stamp}.webm`]);

        try {
            const reply = await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'Screencast',
                new GLib.Variant('(sa{sv})', [template, {
                    'framerate': GLib.Variant.new_int32(30),
                    'draw-cursor': GLib.Variant.new_boolean(true),
                }]),
                new GLib.VariantType('(bs)'),
                Gio.DBusCallFlags.NONE, -1, null);

            const [success, filename] = reply.deepUnpack();
            this._recording = Boolean(success);

            if (this._recording)
                console.log(`${LOG_PREFIX} recording to ${filename}`);
        } catch (e) {
            console.warn(`${LOG_PREFIX} screencast unavailable: ${e.message}`);
            this._recording = false;
        }

        this._syncRecordingButton();
    }

    async _stopRecording() {
        try {
            await Gio.DBus.session.call(
                SCREENCAST_NAME, SCREENCAST_PATH, SCREENCAST_IFACE, 'StopScreencast',
                null, new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not stop screencast: ${e.message}`);
        }

        this._recording = false;
        this._syncRecordingButton();
    }

    /* ------------------------------------------------------------ teardown */

    destroy() {
        this._endDrag();
        this._destroyEditOverlays();

        // Hand every adopted toggle back to the Shell before anything else.
        for (const identifier of [...this._adopted.keys()].reverse())
            this._detachAdopted(identifier);

        if (this._bluezOwnerId) {
            Gio.DBus.system.signal_unsubscribe(this._bluezOwnerId);
            this._bluezOwnerId = 0;
        }

        this._volumeStream?.disconnectObject(this);
        this._volumeStream = null;

        this._brightnessScale?.disconnectObject(this);
        this._brightnessScale = null;
        this._brightnessManager = null;

        this._mixerControl?.close();
        this._mixerControl = null;

        this._mpris?.destroy();
        this._mpris = null;

        this._notificationsSettings = null;
        this._colorSettings = null;
        this._settings = null;

        this._galleryRows = [];
        for (const proxy of this._proxies)
            disposeProxy(proxy);
        this._proxies = [];
        this._wifiProxy = null;
        this._wifiConnectionProxy = null;
        this._brightnessProxy = null;
        this._adapterProxy = null;

        // PanelMenu.Button._onDestroy() destroys this.menu for us.
        super.destroy();
    }
}
