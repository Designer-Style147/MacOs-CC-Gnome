// SPDX-License-Identifier: MIT
//
// Spotlight — a macOS 26 style search overlay.
//
// Shortcuts
//   Alt+Space      open / close
//   Alt+1          Applications (a grid of every installed app)
//   Alt+2          Files (recent files; typing filters them)
//   Alt+3          Clipboard (history since the session started; Delete removes one)
//   Up / Down      move the selection        Enter  open it
//   Tab            next category chip        Esc    clear, then back to search, then close
//
// Where the results come from
// ---------------------------
// GNOME's own search, the one behind the Activities search field, used directly:
//   * applications: Shell.AppSystem.search(), ranked by Shell.AppUsage, exactly as
//     the Shell's application provider does;
//   * everything else (Settings, Files, Calculator, Terminal, Contacts, ...): the
//     D-Bus search providers installed apps ship, loaded by the Shell's own
//     loadRemoteSearchProviders() and filtered by Settings -> Search.
// Nothing here reaches into the overview's private state.
//
// The glass
// ---------
// With the Liquid Glass renderer (glassSurface.js) one glass surface sits under
// everything and draws a piece of real glass behind the search capsule, each
// round button and the card: blur, refraction at the edge, rim light, tint. The
// bubbles themselves paint only their content. Without it each piece blurs on its
// own (blur.js) and the CSS draws its fill.
//
// Layout tree (every node carries a style class for CSS targeting). Like macOS 26
// it is three separate pieces of glass:
//
//   .cc-spot-backdrop                 full-monitor modal layer; a click on it closes
//   ├── (the glass surface)           under everything, when the renderer is there
//   └── .cc-spot-column               everything, laid out top to bottom
//       ├── .cc-spot-top              one row
//       │   ├── .cc-spot-bar          the search capsule: glyph + entry
//       │   └── .cc-spot-circle ×3    Applications / Files / Clipboard
//       └── .cc-spot-card             results, shown only when there is something to show
//           └── .cc-spot-card-content
//               ├── .cc-spot-chips        category chips, one per provider that answered
//               ├── .cc-spot-scroll       results: one .cc-spot-row per result
//               └── .cc-spot-grid-scroll  the Applications view: a grid of .cc-spot-app

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {attachBlur, detachBlur} from './blur.js';
import {GlassRim} from './glass.js';
import {FrameLoop, glassAvailable, GlassSurface, screenRect} from './glassSurface.js';

const LOG_PREFIX = '[macos-control-center/spotlight]';

const ACCELERATOR = '<Alt>space';

// The Shell binds Alt+Space to the window menu. It has to be freed before the
// accelerator above can be grabbed, and is given back in destroy().
const WM_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const WM_KEY = 'activate-window-menu';

// A bright glass, under dark text.
const SPOTLIGHT_GLASS = {
    tint: [1, 1, 1],
    tintStrength: 0.55,
    cornerRadius: 31,
    blurRadius: 14,
    brightness: 1.12,
    saturation: 1.4,
};

// How long the glass keeps following after a layout change, ms.
const FOLLOW_MS = 220;

const BUBBLE_BLUR = {sigma: 26, brightness: 1.06, radius: 'full'};
const CARD_BLUR = {sigma: 28, brightness: 1.04, radius: 30};
const CHIP_BLUR = {sigma: 10, brightness: 1.0, radius: 'full'};
const SELECTION_BLUR = {sigma: 10, brightness: 1.0, radius: 16};

const SEARCH_DELAY_MS = 90;
const MAX_PER_PROVIDER = 5;
const MAX_RESULTS = 9;
const MAX_LOCAL_RESULTS = 40;
const ROW_ICON_SIZE = 36;
const GRID_ICON_SIZE = 52;
const GRID_COLUMNS = 5;

const MAX_RECENT_FILES = 60;
const MAX_CLIPBOARD_ENTRIES = 50;
const MAX_CLIPBOARD_CHARS = 8000;

// Physical keys (evdev code + 8), so Alt+1/2/3 work on every keyboard layout,
// including ones where the digits need Shift.
const KEYCODE_1 = 10;
const KEYCODE_2 = 11;
const KEYCODE_3 = 12;

const MODE_SEARCH = 'search';
const MODE_APPS = 'apps';
const MODE_FILES = 'files';
const MODE_CLIPBOARD = 'clipboard';

/**
 * One element rises into place: opacity and the transform ease with different
 * curves, because an overshooting curve would push the opacity out of range.
 *
 * @param {Clutter.Actor} actor
 * @param {number} index position in the sequence, which sets the delay
 */
function popIn(actor, index) {
    const delay = index * 24;

    actor.remove_all_transitions();
    actor.set({opacity: 0, translation_y: 10});
    actor.ease({
        opacity: 255,
        duration: 180,
        delay,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    actor.ease({
        translation_y: 0,
        duration: 340,
        delay,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

/**
 * The button gives a little under the pointer and springs back.
 *
 * @param {St.Button} button
 */
function addPressFeedback(button) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        const down = button.pressed;
        button.ease({
            scale_x: down ? 0.93 : 1,
            scale_y: down ? 0.93 : 1,
            duration: down ? 80 : 300,
            mode: down
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    });
}

/* ------------------------------------------------------------------------ *
 * Providers. Every one has the shape of a Shell search provider:
 *   getInitialResultSet(terms, cancellable) -> ids
 *   getResultMetas(ids, cancellable)        -> [{id, name, description, createIcon}]
 *   activateResult(id, terms)
 * ------------------------------------------------------------------------ */

/** GNOME's application search: Shell.AppSystem.search(), ranked by usage. */
class ApplicationsProvider {
    constructor(gettext) {
        this.id = 'applications';
        this.appInfo = null;
        this.title = gettext('Applications');
    }

    async getInitialResultSet(terms) {
        const system = Shell.AppSystem.get_default();
        const query = terms.join(' ');
        let groups = [];

        if (typeof Shell.AppSystem.search === 'function') {
            groups = Shell.AppSystem.search(query);
        } else {
            // Not expected on 45+, but a name match is better than no apps at all.
            const needles = terms.map(term => term.toLowerCase());
            groups = [system.get_installed()
                .filter(info => needles.every(n => info.get_name().toLowerCase().includes(n)))
                .map(info => info.get_id())];
        }

        let usage = null;
        try {
            usage = Shell.AppUsage.get_default();
        } catch {
            usage = null;
        }

        const results = [];
        for (let group of groups) {
            group = group.filter(id => Gio.DesktopAppInfo.new(id)?.should_show());
            if (usage)
                group.sort((a, b) => usage.compare(a, b));
            results.push(...group);
        }

        return results;
    }

    filterResults(ids, maxResults) {
        return ids.slice(0, maxResults);
    }

    async getResultMetas(ids) {
        const system = Shell.AppSystem.get_default();

        return ids.map(id => {
            const app = system.lookup_app(id);
            return {
                id,
                name: app?.get_name() ?? id,
                description: app?.get_description() ?? '',
                createIcon: size => app?.create_icon_texture(size) ?? null,
            };
        });
    }

    activateResult(id) {
        Shell.AppSystem.get_default().lookup_app(id)?.activate();
    }
}

/** Recently used files, read from the desktop's own recently-used.xbel. */
class RecentFilesProvider {
    #entries = [];

    constructor(gettext) {
        this.id = 'files';
        this.appInfo = null;
        this.title = gettext('Files');
    }

    /** Re-reads the list; cheap enough to do every time the Files view opens. */
    reload() {
        const entries = [];

        try {
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                throw new Error('could not read recently-used.xbel');

            const xml = new TextDecoder().decode(bytes);
            const decode = text => text
                .replaceAll('&quot;', '"').replaceAll('&apos;', '\'')
                .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

            for (const chunk of xml.split('<bookmark ').slice(1)) {
                const href = /href="([^"]+)"/.exec(chunk)?.[1];
                if (!href)
                    continue;

                const uri = decode(href);
                if (!uri.startsWith('file://'))
                    continue;

                const file = Gio.File.new_for_uri(uri);
                if (!file.query_exists(null))
                    continue;

                entries.push({
                    uri,
                    name: file.get_basename() ?? uri,
                    path: file.get_path() ?? uri,
                    mime: /<mime:mime-type type="([^"]+)"/.exec(chunk)?.[1] ?? 'application/octet-stream',
                    modified: /modified="([^"]+)"/.exec(chunk)?.[1] ?? '',
                });
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not read the recent files: ${e.message}`);
        }

        // ISO timestamps sort as text; newest first.
        entries.sort((a, b) => b.modified.localeCompare(a.modified));
        this.#entries = entries.slice(0, MAX_RECENT_FILES);
    }

    /** @param {string[]} terms lower-case words that must all be in the name or path */
    list(terms) {
        const home = GLib.get_home_dir();

        return this.#entries
            .filter(entry => {
                const haystack = `${entry.name} ${entry.path}`.toLowerCase();
                return terms.every(term => haystack.includes(term));
            })
            .map(entry => {
                const folder = GLib.path_get_dirname(entry.path);
                return {
                    id: entry.uri,
                    name: entry.name,
                    description: folder.startsWith(home) ? `~${folder.slice(home.length)}` : folder,
                    createIcon: size => new St.Icon({
                        gicon: Gio.content_type_get_icon(entry.mime),
                        icon_size: size,
                    }),
                };
            });
    }

    async getInitialResultSet() {
        return [];
    }

    activateResult(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not open ${uri}: ${e.message}`);
        }
    }
}

/**
 * Clipboard history. GNOME keeps none, so this records what is copied from the
 * moment the extension is enabled. It lives in memory only: nothing is written
 * to disk, and it is gone when the session ends.
 */
class ClipboardProvider {
    #entries = [];
    #nextId = 1;
    #selection = null;
    #selectionSignalId = 0;

    constructor(gettext) {
        this.id = 'clipboard';
        this.appInfo = null;
        this.title = gettext('Clipboard');
        this._gettext = gettext;

        try {
            this.#selection = global.display.get_selection();
            this.#selectionSignalId = this.#selection.connect('owner-changed',
                (_selection, type) => {
                    if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                        this.#capture();
                });
        } catch (e) {
            console.warn(`${LOG_PREFIX} clipboard history is unavailable: ${e.message}`);
        }

        // What is on the clipboard right now is the first entry.
        this.#capture();
    }

    #capture() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (!text || text.trim() === '')
                return;

            text = text.slice(0, MAX_CLIPBOARD_CHARS);

            // Copying something already in the history moves it to the top.
            this.#entries = this.#entries.filter(entry => entry.text !== text);
            this.#entries.unshift({id: String(this.#nextId++), text});
            this.#entries.length = Math.min(this.#entries.length, MAX_CLIPBOARD_ENTRIES);
        });
    }

    /** @param {string[]} terms lower-case words that must all be in the text */
    list(terms) {
        return this.#entries
            .filter(entry => {
                const haystack = entry.text.toLowerCase();
                return terms.every(term => haystack.includes(term));
            })
            .map(entry => {
                const lines = entry.text.split('\n').map(line => line.trim()).filter(Boolean);
                const first = lines[0] ?? entry.text.trim();
                const extra = lines.length > 1
                    ? ` · ${lines.length} ${this._gettext('lines')}`
                    : '';

                return {
                    id: entry.id,
                    name: first.length > 90 ? `${first.slice(0, 90)}…` : first,
                    description: `${entry.text.length} ${this._gettext('characters')}${extra}`,
                    createIcon: size => new St.Icon({
                        icon_name: 'edit-paste-symbolic',
                        icon_size: size,
                    }),
                };
            });
    }

    /** @param {string} id */
    remove(id) {
        this.#entries = this.#entries.filter(entry => entry.id !== id);
    }

    async getInitialResultSet() {
        return [];
    }

    activateResult(id) {
        const entry = this.#entries.find(candidate => candidate.id === id);
        if (entry)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text);
    }

    destroy() {
        if (this.#selection && this.#selectionSignalId)
            this.#selection.disconnect(this.#selectionSignalId);
        this.#selectionSignalId = 0;
        this.#selection = null;
        this.#entries = [];
    }
}

export class Spotlight {
    #gettext;

    #applications;
    #files;
    #clipboard;
    #remote = [];
    #searchSettings = null;
    #searchSettingsIds = [];

    #path;
    #glass = null;
    #glassLoop = null;
    #glassActive = false;
    #follow = null;
    #monitor = null;

    #backdrop = null;
    #column = null;
    #panel = null;
    #top = null;
    #bar = null;
    #card = null;
    #cardShown = false;
    #entry = null;
    #modeButtons = new Map();
    #chipBox = null;
    #resultScroll = null;
    #resultList = null;
    #gridScroll = null;
    #gridColumn = null;
    #gridTiles = [];
    #gridSelected = -1;
    #gridBuilt = false;

    #grab = null;
    #isOpen = false;
    #mode = MODE_SEARCH;

    #groups = [];
    #filter = null;
    #items = [];
    #selected = -1;
    #terms = [];
    #searchDone = false;

    #generation = 0;
    #cancellable = null;
    #searchTimeoutId = 0;

    #acceleratorAction = Meta.KeyBindingAction.NONE;
    #acceleratorSignalId = 0;
    #acceleratorRetryId = 0;
    #savedWindowMenu = null;

    /** @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension */
    constructor(extension) {
        this.#gettext = extension.gettext.bind(extension);
        this.#path = extension.path;

        this.#applications = new ApplicationsProvider(this.#gettext);
        this.#files = new RecentFilesProvider(this.#gettext);
        this.#clipboard = new ClipboardProvider(this.#gettext);

        this.#build();
        this.#loadRemoteProviders();
        this.#freeWindowMenuShortcut();
        this.#grabAccelerator(0);
    }

    /* ------------------------------------------------------------- building */

    #build() {
        // Absolute: the column is placed by hand, and the glass surface fills it.
        this.#backdrop = new St.Widget({
            style_class: 'cc-spot-backdrop',
            reactive: true,
            visible: false,
        });
        this.#backdrop.connect('button-press-event', (_actor, event) => {
            // Only a press on the backdrop itself: the bubbles are reactive and
            // swallow their own.
            if (event.get_source() === this.#backdrop) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.#backdrop.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Everything is one column, so the whole overlay can be animated as one.
        this.#column = new St.BoxLayout({
            style_class: 'cc-spot-column',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.#panel = this.#column;

        // --- the top row: the search capsule and the three views ---------------
        this.#top = new St.BoxLayout({
            style_class: 'cc-spot-top',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this.#top.add_child(this.#buildSearchBar());

        for (const [mode, label, iconName, key] of [
            [MODE_APPS, this.#gettext('Applications'), 'view-app-grid-symbolic', 'Alt+1'],
            [MODE_FILES, this.#gettext('Files'), 'folder-symbolic', 'Alt+2'],
            [MODE_CLIPBOARD, this.#gettext('Clipboard'), 'edit-paste-symbolic', 'Alt+3'],
        ])
            this.#top.add_child(this.#createModeButton(mode, label, iconName, key));

        this.#column.add_child(this.#top);

        // --- the card of results (hidden until there is something to show) ---
        this.#card = new St.Widget({
            style_class: 'cc-spot-card',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
            visible: false,
        });
        attachBlur(this.#card, CARD_BLUR);

        const cardContent = new St.BoxLayout({
            style_class: 'cc-spot-card-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this.#chipBox = new St.BoxLayout({
            style_class: 'cc-spot-chips',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            visible: false,
        });
        cardContent.add_child(this.#chipBox);

        this.#resultList = new St.BoxLayout({
            style_class: 'cc-spot-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.#resultScroll = new St.ScrollView({
            style_class: 'cc-spot-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            visible: false,
            child: this.#resultList,
        });
        cardContent.add_child(this.#resultScroll);

        // The applications grid is built on first use.
        this.#gridScroll = new St.ScrollView({
            style_class: 'cc-spot-grid-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            visible: false,
        });
        cardContent.add_child(this.#gridScroll);

        this.#card.add_child(cardContent);
        this.#card.add_child(new GlassRim({radius: 30, sheen: 0.8}));
        this.#column.add_child(this.#card);

        if (glassAvailable) {
            this.#glass = new GlassSurface({path: this.#path, owner: 'spotlight', material: SPOTLIGHT_GLASS});
            this.#glassLoop = new FrameLoop(() => this.#syncGlass());
            this.#backdrop.add_child(this.#glass.actor);

            // The glass reads the layout before it is redone, so after a change
            // it keeps following for a moment: the ticker asks for the frames.
            this.#follow = new Clutter.Timeline({actor: this.#backdrop, duration: FOLLOW_MS});
            for (const actor of [this.#column, this.#card])
                actor.connect('notify::allocation', () => this.#keepFollowing());
        }

        this.#backdrop.add_child(this.#column);
        Main.uiGroup.add_child(this.#backdrop);
    }

    /**
     * The glass draws the bubbles' material, so their own fill and rim give way
     * to it, but only while it is really drawing (its shaders are loaded).
     *
     * @param {boolean} active
     */
    #setGlassActive(active) {
        if (this.#glassActive === active)
            return;
        this.#glassActive = active;

        if (active)
            this.#column.add_style_class_name('cc-glass-active');
        else
            this.#column.remove_style_class_name('cc-glass-active');

        const setRims = actor => {
            for (const child of actor.get_children()) {
                if (child instanceof GlassRim)
                    child.visible = !active;
                else
                    setRims(child);
            }
        };
        setRims(this.#column);
    }

    #keepFollowing() {
        if (!this.#follow)
            return;
        if (this.#follow.is_playing())
            this.#follow.rewind();
        else
            this.#follow.start();
    }

    /** Once per frame while shown: a piece of glass behind each bubble. */
    #syncGlass() {
        if (!this.#glass || !this.#monitor || !this.#backdrop.mapped) {
            this.#glass?.hide();
            return;
        }

        const rects = [];
        for (const actor of [this.#bar, ...this.#modeButtons.values(), this.#card]) {
            if (!actor.visible || !actor.mapped || actor.get_paint_opacity() < 12)
                continue;
            rects.push(screenRect(actor));
        }

        this.#glass.setOpacity(this.#column.get_paint_opacity());
        // The glass sits in the backdrop, which already is at the monitor's origin.
        this.#glass.sync(rects, this.#monitor, [0, 0]);
        this.#setGlassActive(this.#glass.ready);
    }

    /** @returns {St.Widget} the search capsule */
    #buildSearchBar() {
        const bar = new St.Widget({
            style_class: 'cc-spot-bar',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: true,
        });
        attachBlur(bar, BUBBLE_BLUR);
        this.#bar = bar;

        const row = new St.BoxLayout({
            style_class: 'cc-spot-search-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        row.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'cc-spot-search-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.#entry = new St.Entry({
            style_class: 'cc-spot-entry',
            hint_text: this.#gettext('Spotlight Search'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.#entry.clutter_text.connect('text-changed', () => this.#onTextChanged());
        this.#entry.clutter_text.connect('key-press-event',
            (_actor, event) => this.#onKeyPress(event));
        row.add_child(this.#entry);

        bar.add_child(row);
        bar.add_child(new GlassRim({radius: 'full'}));

        return bar;
    }

    /**
     * One of the round buttons beside the search capsule.
     *
     * @param {string} mode
     * @param {string} label
     * @param {string} iconName
     * @param {string} key the shortcut, read out with the name
     * @returns {St.Button}
     */
    #createModeButton(mode, label, iconName, key) {
        const button = new St.Button({
            style_class: 'cc-spot-circle',
            can_focus: false,
            reactive: true,
            track_hover: true,
            accessible_name: `${label} (${key})`,
        });

        const host = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        host.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'cc-spot-circle-icon',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        host.add_child(new GlassRim({radius: 'full'}));
        button.set_child(host);

        attachBlur(button, BUBBLE_BLUR);
        addPressFeedback(button);

        button.connect('clicked', () => this.#toggleMode(mode));
        this.#modeButtons.set(mode, button);

        return button;
    }

    /* ------------------------------------------------------- search providers */

    /**
     * The D-Bus search providers installed apps ship, filtered and ordered by
     * Settings -> Search. Loaded by the Shell's own code, and again whenever that
     * configuration changes.
     */
    async #loadRemoteProviders() {
        try {
            const {loadRemoteSearchProviders} =
                await import('resource:///org/gnome/shell/ui/remoteSearch.js');

            if (!this.#searchSettings) {
                this.#searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
                for (const key of ['disabled', 'enabled', 'sort-order', 'disable-external']) {
                    this.#searchSettingsIds.push(this.#searchSettings.connect(`changed::${key}`,
                        () => this.#loadRemoteProviders()));
                }
            }

            this.#remote = loadRemoteSearchProviders(this.#searchSettings);
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not load the search providers, applications only: ${e.message}`);
            this.#remote = [];
        }
    }

    /** @returns {object[]} applications first, then the providers of Settings -> Search */
    #providers() {
        return [this.#applications, ...this.#remote];
    }

    /* ------------------------------------------------------------ shortcut */

    /**
     * Alt+Space belongs to the window menu. The binding is removed for as long as
     * the extension is enabled, and put back exactly as it was (default or the
     * user's own value) in #restoreWindowMenuShortcut().
     */
    #freeWindowMenuShortcut() {
        try {
            const settings = new Gio.Settings({schema_id: WM_SCHEMA});
            const current = settings.get_strv(WM_KEY);
            const wanted = ACCELERATOR.toLowerCase();

            if (!current.some(accel => accel.toLowerCase() === wanted))
                return;

            this.#savedWindowMenu = {settings, original: settings.get_user_value(WM_KEY)};
            settings.set_strv(WM_KEY, current.filter(accel => accel.toLowerCase() !== wanted));
            Gio.Settings.sync();
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not free ${ACCELERATOR} from the window menu: ${e.message}`);
        }
    }

    #restoreWindowMenuShortcut() {
        const saved = this.#savedWindowMenu;
        this.#savedWindowMenu = null;
        if (!saved)
            return;

        try {
            if (saved.original)
                saved.settings.set_value(WM_KEY, saved.original);
            else
                saved.settings.reset(WM_KEY);
            Gio.Settings.sync();
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not restore the window menu shortcut: ${e.message}`);
        }
    }

    /**
     * A global accelerator that needs no GSettings key: the Shell hands the
     * activation over through Meta.Display's `accelerator-activated`. Mutter
     * applies the change to the window menu binding a moment after the setting
     * changes, so a refused grab is retried briefly.
     *
     * @param {number} attempt
     */
    #grabAccelerator(attempt) {
        try {
            const action = global.display.grab_accelerator(ACCELERATOR, Meta.KeyBindingFlags.NONE);

            if (action === Meta.KeyBindingAction.NONE) {
                if (attempt < 12) {
                    this.#acceleratorRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this.#acceleratorRetryId = 0;
                        this.#grabAccelerator(attempt + 1);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    console.warn(`${LOG_PREFIX} ${ACCELERATOR} is taken by something else; no shortcut.`);
                }
                return;
            }

            this.#acceleratorAction = action;
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
                Shell.ActionMode.ALL);

            this.#acceleratorSignalId = global.display.connect('accelerator-activated',
                (_display, activated) => {
                    if (activated === this.#acceleratorAction)
                        this.toggle();
                });
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not grab ${ACCELERATOR}: ${e.message}`);
        }
    }

    #releaseAccelerator() {
        if (this.#acceleratorRetryId) {
            GLib.source_remove(this.#acceleratorRetryId);
            this.#acceleratorRetryId = 0;
        }

        if (this.#acceleratorSignalId) {
            global.display.disconnect(this.#acceleratorSignalId);
            this.#acceleratorSignalId = 0;
        }

        if (this.#acceleratorAction !== Meta.KeyBindingAction.NONE) {
            try {
                global.display.ungrab_accelerator(this.#acceleratorAction);
                Main.wm.allowKeybinding(
                    Meta.external_binding_name_for_action(this.#acceleratorAction),
                    Shell.ActionMode.NONE);
            } catch (e) {
                console.warn(`${LOG_PREFIX} could not release ${ACCELERATOR}: ${e.message}`);
            }
            this.#acceleratorAction = Meta.KeyBindingAction.NONE;
        }
    }

    /* ------------------------------------------------------------ open/close */

    toggle() {
        if (this.#isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.#isOpen || Main.sessionMode.isLocked)
            return;

        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()] ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.#monitor = monitor;
        this.#backdrop.set_position(monitor.x, monitor.y);
        this.#backdrop.set_size(monitor.width, monitor.height);

        // Centred, in the upper part of the screen, like macOS.
        const [, columnWidth] = this.#column.get_preferred_width(-1);
        this.#column.set_position(
            Math.round((monitor.width - columnWidth) / 2),
            Math.round(monitor.height * 0.16));

        this.#resetState();
        this.#backdrop.show();

        const grab = Main.pushModal(this.#backdrop, {actionMode: Shell.ActionMode.POPUP});
        if (!grab) {
            this.#backdrop.hide();
            return;
        }

        this.#grab = grab;
        this.#isOpen = true;

        this.#panel.remove_all_transitions();
        // Drops in from slightly above and a touch small, overshoots, settles.
        this.#panel.set({opacity: 0, scale_x: 0.93, scale_y: 0.93, translation_y: -14});
        this.#panel.set_pivot_point(0.5, 0.0);
        this.#panel.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this.#panel.ease({
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: 440,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        this.#top.get_children().forEach((child, index) => popIn(child, index));

        this.#glassLoop?.start();
        this.#entry.grab_key_focus();
    }

    close() {
        if (!this.#isOpen)
            return;

        this.#isOpen = false;
        this.#cancelSearch();

        if (this.#grab) {
            Main.popModal(this.#grab);
            this.#grab = null;
        }

        this.#panel.remove_all_transitions();
        this.#panel.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            translation_y: -8,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this.#isOpen)
                    return;

                this.#glassLoop?.stop();
                this.#glass?.hide();
                this.#backdrop.hide();
            },
        });
    }

    #resetState() {
        this.#cancelSearch();
        this.#card.remove_all_transitions();
        this.#card.set({visible: false, opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0});
        this.#cardShown = false;
        this.#mode = MODE_SEARCH;
        this.#entry.set_text('');
        this.#groups = [];
        this.#filter = null;
        this.#items = [];
        this.#selected = -1;
        this.#terms = [];
        this.#searchDone = false;
        this.#applyMode(false);
    }

    /* --------------------------------------------------------------- input */

    /**
     * @param {Clutter.Event} event
     * @returns {boolean} Clutter.EVENT_STOP when the key was used here
     */
    #onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const keycode = event.get_key_code();
        const alt = (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;

        // Alt+Space closes again (the global accelerator may not reach a modal).
        if (alt && symbol === Clutter.KEY_space) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        // Alt+1 / Alt+2 / Alt+3: the three views.
        if (alt) {
            const mode = {
                [KEYCODE_1]: MODE_APPS,
                [KEYCODE_2]: MODE_FILES,
                [KEYCODE_3]: MODE_CLIPBOARD,
            }[keycode];

            if (mode) {
                this.#toggleMode(mode);
                return Clutter.EVENT_STOP;
            }
        }

        if (this.#mode === MODE_APPS && this.#onGridKey(symbol))
            return Clutter.EVENT_STOP;

        switch (symbol) {
        case Clutter.KEY_Escape:
            // First Esc clears the text, the next leaves a view, the last closes.
            if (this.#entry.get_text() !== '')
                this.#entry.set_text('');
            else if (this.#mode !== MODE_SEARCH)
                this.#setMode(MODE_SEARCH);
            else
                this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            this.#moveSelection(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this.#moveSelection(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this.#cycleFilter(symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this.#activateSelected();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
            // In the clipboard view, with nothing typed, Delete drops one entry.
            if (this.#mode === MODE_CLIPBOARD && this.#entry.get_text() === '') {
                this.#removeSelectedClipboardEntry();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    #onTextChanged() {
        const text = this.#entry.get_text();

        // Typing in the application grid is searching.
        if (text !== '' && this.#mode === MODE_APPS)
            this.#setMode(MODE_SEARCH);

        this.#updateModeBar();
        this.#cancelSearch();

        // Files and Clipboard are local lists: typing filters them at once.
        if (this.#mode === MODE_FILES || this.#mode === MODE_CLIPBOARD) {
            this.#showLocalList(false);
            return;
        }

        if (text.trim() === '') {
            this.#groups = [];
            this.#filter = null;
            this.#items = [];
            this.#selected = -1;
            this.#terms = [];
            this.#searchDone = false;
            this.#renderChips();
            this.#renderResults();
            return;
        }

        // A burst of keystrokes is one search.
        this.#searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this.#searchTimeoutId = 0;
            this.#search(text).catch(e => console.warn(`${LOG_PREFIX} search failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    #cancelSearch() {
        if (this.#searchTimeoutId) {
            GLib.source_remove(this.#searchTimeoutId);
            this.#searchTimeoutId = 0;
        }

        this.#cancellable?.cancel();
        this.#cancellable = null;
        // Anything still in flight belongs to a search nobody wants any more.
        this.#generation++;
        this.#searchDone = false;
    }

    /* --------------------------------------------------------------- modes */

    /** @param {string} mode pressing a view's shortcut a second time leaves it */
    #toggleMode(mode) {
        this.#setMode(this.#mode === mode ? MODE_SEARCH : mode);
    }

    /** @param {string} mode */
    #setMode(mode) {
        if (this.#mode === mode)
            return;

        this.#mode = mode;
        this.#cancelSearch();

        // Every view starts from an empty field.
        if (this.#entry.get_text() !== '')
            this.#entry.set_text('');

        this.#applyMode(true);
    }

    /** Shows what the current mode asks for. @param {boolean} animate */
    #applyMode(animate) {
        this.#gridSelected = -1;

        switch (this.#mode) {
        case MODE_APPS:
            this.#entry.hint_text = this.#gettext('Applications');
            this.#groups = [];
            this.#items = [];
            this.#selected = -1;
            this.#renderChips();
            // The card is refreshed once, below, after the grid is shown: doing it
            // here would fold it away only to bring it straight back.
            this.#renderResultsCore(false);
            this.#resultScroll.hide();
            this.#showAppGrid(animate);
            break;

        case MODE_FILES:
            this.#entry.hint_text = this.#gettext('Files');
            this.#gridScroll.hide();
            this.#files.reload();
            this.#showLocalList(animate);
            break;

        case MODE_CLIPBOARD:
            this.#entry.hint_text = this.#gettext('Clipboard');
            this.#gridScroll.hide();
            this.#showLocalList(animate);
            break;

        default:
            this.#entry.hint_text = this.#gettext('Spotlight Search');
            this.#gridScroll.hide();
            this.#groups = [];
            this.#filter = null;
            this.#items = [];
            this.#selected = -1;
            this.#terms = [];
            this.#renderChips();
            this.#renderResults();
        }

        this.#updateModeBar();
        this.#updateCard();
    }

    /** The round button of the current view is lit. */
    #updateModeBar() {
        for (const [mode, button] of this.#modeButtons) {
            if (mode === this.#mode)
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
        }
    }

    /** The Files / Clipboard views: one list, filtered by what is typed. */
    #showLocalList(animate) {
        const provider = this.#mode === MODE_FILES ? this.#files : this.#clipboard;
        const terms = this.#entry.get_text().toLowerCase().split(/\s+/).filter(Boolean);
        const metas = provider.list(terms);

        this.#terms = terms;
        this.#groups = metas.length > 0 ? [{provider, metas, order: 0}] : [];
        this.#filter = null;
        this.#searchDone = true;
        this.#rebuildItems();
        this.#renderChips();
        this.#renderResults(animate);
    }

    #removeSelectedClipboardEntry() {
        const item = this.#items[this.#selected];
        if (!item)
            return;

        const keep = this.#selected;
        this.#clipboard.remove(item.meta.id);
        this.#showLocalList(false);
        this.#selected = Math.min(keep, this.#items.length - 1);
        this.#applySelection();
    }

    /* --------------------------------------------------------------- search */

    /** @param {string} text */
    async #search(text) {
        const generation = ++this.#generation;
        this.#cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this.#cancellable = cancellable;

        const terms = text.trim().split(/\s+/).filter(Boolean);
        const providers = this.#providers();
        const groups = [];

        await Promise.all(providers.map(async provider => {
            try {
                let ids = await provider.getInitialResultSet(terms, cancellable);
                if (!ids || ids.length === 0)
                    return;

                ids = typeof provider.filterResults === 'function'
                    ? provider.filterResults(ids, MAX_PER_PROVIDER)
                    : ids.slice(0, MAX_PER_PROVIDER);

                const metas = await provider.getResultMetas(ids, cancellable);
                if (metas && metas.length > 0)
                    groups.push({provider, metas, order: providers.indexOf(provider)});
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`${LOG_PREFIX} provider ${provider.id} failed: ${e.message}`);
            }
        }));

        // A newer search, a closed overlay: drop this answer.
        if (generation !== this.#generation || !this.#isOpen)
            return;

        groups.sort((a, b) => a.order - b.order);

        // A list that was already showing results updates in place; only a list
        // appearing from nothing plays the entrance.
        const appearing = this.#items.length === 0;

        this.#terms = terms;
        this.#groups = groups;
        this.#filter = null;
        this.#searchDone = true;
        this.#rebuildItems();
        this.#renderChips(appearing);
        this.#renderResults(appearing);
    }

    /** @param {{provider: object}} group @returns {string} */
    #groupName(group) {
        const {provider} = group;

        if (provider.appInfo)
            return provider.appInfo.get_name();

        return provider.title ?? provider.id;
    }

    /** Flattens the groups the chip filter lets through into one list of rows. */
    #rebuildItems() {
        const limit = this.#mode === MODE_SEARCH ? MAX_RESULTS : MAX_LOCAL_RESULTS;
        const items = [];

        for (const group of this.#groups) {
            if (this.#filter !== null && this.#filter !== group)
                continue;

            for (const meta of group.metas) {
                if (items.length >= limit)
                    break;
                items.push({group, meta});
            }
        }

        this.#items = items;
        this.#selected = items.length > 0 ? 0 : -1;
    }

    /* -------------------------------------------------------------- results */

    /** @param {boolean} [animate] whether the chips pop in */
    #renderChips(animate = false) {
        this.#chipBox.destroy_all_children();

        if (this.#groups.length < 2) {
            this.#chipBox.hide();
            return;
        }

        let chipIndex = 0;
        const addChip = (label, group) => {
            const chip = new St.Button({
                style_class: 'cc-spot-chip',
                can_focus: false,
                reactive: true,
                track_hover: true,
                label,
            });
            if (this.#filter === group)
                chip.add_style_pseudo_class('selected');

            attachBlur(chip, CHIP_BLUR);
            chip.connect('clicked', () => {
                this.#filter = group;
                this.#rebuildItems();
                this.#renderChips();
                this.#renderResults(true);
            });
            this.#chipBox.add_child(chip);

            if (animate) {
                chip.set_pivot_point(0.5, 0.5);
                chip.set({opacity: 0, scale_x: 0.7, scale_y: 0.7});
                chip.ease({
                    opacity: 255,
                    duration: 160,
                    delay: chipIndex * 40,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                chip.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 360,
                    delay: chipIndex * 40,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
            chipIndex++;
        };

        addChip(this.#gettext('All'), null);
        for (const group of this.#groups)
            addChip(this.#groupName(group), group);

        this.#chipBox.show();
    }

    /** The line shown when the list is empty, or null for nothing at all. */
    #emptyMessage() {
        const typed = this.#entry.get_text().trim() !== '';

        switch (this.#mode) {
        case MODE_FILES:
            return typed ? this.#gettext('No matching files') : this.#gettext('No recent files');
        case MODE_CLIPBOARD:
            return typed
                ? this.#gettext('Nothing matches')
                : this.#gettext('The clipboard history is empty');
        case MODE_SEARCH:
            return typed && this.#searchDone ? this.#gettext('No Results') : null;
        default:
            return null;
        }
    }

    /** @param {boolean} [animate] whether the rows rise into place one after another */
    #renderResults(animate = false) {
        this.#renderResultsCore(animate);
        this.#updateCard();
    }

    /**
     * The card appears when there is anything to show in it (chips, results, the
     * application grid) and folds away when there is not.
     */
    #updateCard() {
        const wanted = this.#chipBox.visible || this.#resultScroll.visible || this.#gridScroll.visible;
        if (wanted === this.#cardShown)
            return;

        this.#cardShown = wanted;
        this.#card.remove_all_transitions();

        if (wanted) {
            this.#card.set_pivot_point(0.5, 0.0);
            this.#card.set({visible: true, opacity: 0, scale_x: 0.95, scale_y: 0.95, translation_y: -12});
            this.#card.ease({
                opacity: 255,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            this.#card.ease({
                scale_x: 1,
                scale_y: 1,
                translation_y: 0,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this.#card.ease({
                opacity: 0,
                duration: 110,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (!this.#cardShown)
                        this.#card.hide();
                },
            });
        }
    }

    /** @param {boolean} animate */
    #renderResultsCore(animate) {
        this.#resultList.destroy_all_children();

        if (this.#items.length === 0) {
            const message = this.#mode === MODE_APPS ? null : this.#emptyMessage();

            if (message) {
                this.#resultList.add_child(new St.Label({
                    text: message,
                    style_class: 'cc-spot-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
                this.#resultScroll.show();
            } else {
                this.#resultScroll.hide();
            }
            return;
        }

        this.#items.forEach((item, index) => {
            item.row = this.#createRow(item, index);
            this.#resultList.add_child(item.row);
            if (animate)
                popIn(item.row, index);
        });

        this.#resultScroll.show();
        this.#applySelection();
    }

    /**
     * @param {{group: object, meta: object}} item
     * @param {number} index
     * @returns {St.Button}
     */
    #createRow(item, index) {
        const {group, meta} = item;

        const row = new St.Button({
            style_class: 'cc-spot-row',
            can_focus: false,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-spot-row-content',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        let icon = null;
        try {
            icon = typeof meta.createIcon === 'function' ? meta.createIcon(ROW_ICON_SIZE) : null;
        } catch (e) {
            console.warn(`${LOG_PREFIX} icon of ${meta.id} failed: ${e.message}`);
        }
        if (!icon) {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: ROW_ICON_SIZE,
            });
        }
        icon.y_align = Clutter.ActorAlign.CENTER;
        icon.add_style_class_name('cc-spot-row-icon');
        box.add_child(icon);

        const text = new St.BoxLayout({
            style_class: 'cc-spot-row-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            text: meta.name ?? '',
            style_class: 'cc-spot-row-title',
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        const subtitle = new St.Label({
            text: meta.description || this.#groupName(group),
            style_class: 'cc-spot-row-subtitle',
            x_align: Clutter.ActorAlign.START,
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(subtitle);

        box.add_child(text);
        row.set_child(box);

        row.connect('clicked', () => this.#activate(item));
        row.connect('notify::hover', () => {
            if (row.hover && this.#selected !== index) {
                this.#selected = index;
                this.#applySelection(false);
            }
        });

        return row;
    }

    /** @param {boolean} [scroll] whether to bring the selected row into view */
    #applySelection(scroll = true) {
        this.#items.forEach((item, index) => {
            if (!item.row)
                return;

            if (index === this.#selected) {
                item.row.add_style_pseudo_class('selected');
                attachBlur(item.row, SELECTION_BLUR);
            } else {
                item.row.remove_style_pseudo_class('selected');
                detachBlur(item.row);
            }
        });

        const row = this.#items[this.#selected]?.row;
        if (scroll && row)
            Util.ensureActorVisibleInScrollView(this.#resultScroll, row);
    }

    #moveSelection(step) {
        if (this.#mode === MODE_APPS || this.#items.length === 0)
            return;

        const count = this.#items.length;
        this.#selected = (this.#selected + step + count) % count;
        this.#applySelection();
    }

    #cycleFilter(step) {
        if (this.#groups.length < 2)
            return;

        const options = [null, ...this.#groups];
        const current = options.indexOf(this.#filter);
        this.#filter = options[(current + step + options.length) % options.length];

        this.#rebuildItems();
        this.#renderChips();
        this.#renderResults(true);
    }

    #activateSelected() {
        if (this.#mode === MODE_APPS) {
            this.#gridTiles[this.#gridSelected]?.emit('clicked', 0);
            return;
        }

        const item = this.#items[this.#selected];
        if (item)
            this.#activate(item);
    }

    /** @param {{group: object, meta: object}} item */
    #activate(item) {
        const terms = this.#terms;
        // Closing first hands the focus back before the result takes it.
        this.close();

        try {
            item.group.provider.activateResult(item.meta.id, terms);
        } catch (e) {
            console.warn(`${LOG_PREFIX} activating ${item.meta.id} failed: ${e.message}`);
        }
    }

    /* ----------------------------------------------------- applications view */

    /** @param {boolean} animate */
    #showAppGrid(animate) {
        if (!this.#gridBuilt)
            this.#buildAppGrid();

        this.#gridScroll.show();
        if (animate)
            this.#gridColumn?.get_children().forEach((line, index) => popIn(line, index));
    }

    #buildAppGrid() {
        this.#gridBuilt = true;

        const system = Shell.AppSystem.get_default();
        const apps = system.get_installed()
            .filter(info => info.should_show())
            .map(info => system.lookup_app(info.get_id()))
            .filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        const column = new St.BoxLayout({
            style_class: 'cc-spot-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this.#gridTiles = [];
        for (let start = 0; start < apps.length; start += GRID_COLUMNS) {
            const line = new St.BoxLayout({
                style_class: 'cc-spot-grid-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
            });

            for (const app of apps.slice(start, start + GRID_COLUMNS)) {
                const tile = this.#createAppTile(app);
                this.#gridTiles.push(tile);
                line.add_child(tile);
            }

            column.add_child(line);
        }

        this.#gridColumn = column;
        this.#gridScroll.set_child(column);
    }

    /** @param {Shell.App} app @returns {St.Button} */
    #createAppTile(app) {
        const tile = new St.Button({
            style_class: 'cc-spot-app',
            can_focus: false,
            reactive: true,
            track_hover: true,
        });

        const box = new St.BoxLayout({
            style_class: 'cc-spot-app-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const icon = app.create_icon_texture(GRID_ICON_SIZE);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);

        const label = new St.Label({
            text: app.get_name(),
            style_class: 'cc-spot-app-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);

        tile.set_child(box);
        tile.connect('clicked', () => {
            this.close();
            app.activate();
        });

        return tile;
    }

    /**
     * Arrow keys in the application grid.
     *
     * @param {number} symbol
     * @returns {boolean} whether the key was used
     */
    #onGridKey(symbol) {
        const steps = {
            [Clutter.KEY_Right]: 1,
            [Clutter.KEY_Left]: -1,
            [Clutter.KEY_Down]: GRID_COLUMNS,
            [Clutter.KEY_Up]: -GRID_COLUMNS,
        };
        const step = steps[symbol];

        if (step === undefined || this.#gridTiles.length === 0)
            return false;

        const next = this.#gridSelected < 0
            ? 0
            : Math.max(0, Math.min(this.#gridTiles.length - 1, this.#gridSelected + step));

        this.#gridTiles[this.#gridSelected]?.remove_style_pseudo_class('selected');
        this.#gridSelected = next;

        const tile = this.#gridTiles[next];
        tile.add_style_pseudo_class('selected');
        Util.ensureActorVisibleInScrollView(this.#gridScroll, tile);

        return true;
    }

    /* -------------------------------------------------------------- teardown */

    destroy() {
        this.#releaseAccelerator();
        this.#restoreWindowMenuShortcut();
        this.#cancelSearch();

        if (this.#searchSettings) {
            for (const id of this.#searchSettingsIds)
                this.#searchSettings.disconnect(id);
            this.#searchSettingsIds = [];
            this.#searchSettings = null;
        }
        this.#remote = [];

        this.#clipboard.destroy();

        if (this.#grab) {
            Main.popModal(this.#grab);
            this.#grab = null;
        }
        this.#isOpen = false;

        this.#panel?.remove_all_transitions();

        this.#glassLoop?.stop();
        this.#glassLoop = null;
        this.#follow?.stop();
        this.#follow = null;
        this.#glass?.destroy();
        this.#glass = null;

        this.#backdrop?.destroy();
        this.#backdrop = null;
        this.#bar = null;
        this.#panel = null;
        this.#entry = null;
        this.#column = null;
        this.#top = null;
        this.#card = null;
        this.#modeButtons.clear();
        this.#chipBox = null;
        this.#resultScroll = null;
        this.#resultList = null;
        this.#gridScroll = null;
        this.#gridColumn = null;
        this.#gridTiles = [];
        this.#items = [];
        this.#groups = [];
    }
}
