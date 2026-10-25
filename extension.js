// SPDX-License-Identifier: MIT
//
// ESM entry point. Everything is injected in enable() and torn down in
// disable(); the panel and the three top-bar glyphs own their own resources
// (proxies, GSettings, Gvc mixer, MPRIS subscription) so that no object
// outlives the extension.
//
// Besides the control centre button this file places the Wi-Fi, Bluetooth and
// battery glyphs of the reference next to it and moves the clock to the far
// right of the bar. Each glyph carries a dropdown of its own; where they sit is
// a panel-level concern, which is why it lives here rather than inside the
// panel.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    BatteryStatusIndicator,
    BluetoothStatusIndicator,
    ControlCenterPanel,
    WifiStatusIndicator,
} from './controlCenterPanel.js';
import {DockWatcher} from './dockGlass.js';
import {setGlassSettings} from './glassSurface.js';
import {setIconsPath} from './icons.js';
import {Spotlight} from './spotlight.js';

export default class ControlCenterExtension extends Extension {
    #panel = null;
    #indicators = [];
    #clockHome = null;
    #spotlight = null;
    #docks = null;

    enable() {
        const gettext = this.gettext.bind(this);

        // Where the extension's own icons are, before anything asks for one.
        setIconsPath(this.path);

        // The look of the glass, set in the preferences. Read before any surface is
        // made; a missing schema (not compiled yet) just leaves the defaults.
        try {
            setGlassSettings(this.getSettings('org.gnome.shell.extensions.macos-control-center.glass'));
        } catch (e) {
            console.warn(`macos-control-center: the glass settings are not available: ${e.message}`);
        }

        this.#panel = new ControlCenterPanel(this);

        // Radios first, then the battery, so the battery ends up beside the
        // control centre button the way the reference has it.
        const params = {gettext, path: this.path};
        const glyphs = [
            ['wifi', new WifiStatusIndicator(params)],
            ['bluetooth', new BluetoothStatusIndicator(params)],
            ['battery', new BatteryStatusIndicator(params)],
        ];

        // A stale indicator of an earlier enable would still hold the role, and
        // addToStatusArea() throws on a taken role: hand its place over.
        Main.panel.statusArea[this.uuid]?.destroy();
        Main.panel.addToStatusArea(this.uuid, this.#panel, 0, 'right');
        for (const [name, indicator] of glyphs) {
            // Roles are namespaced by the UUID, so the only realistic holder of
            // one of these names is a stale indicator of an earlier enable that
            // never got its disable().
            const role = `${this.uuid}-${name}`;
            Main.panel.statusArea[role]?.destroy();

            Main.panel.addToStatusArea(role, indicator, 0, 'right');
            this.#indicators.push(indicator);
        }

        this.#arrangeStatusArea();

        // Spotlight is independent of the bar: if it cannot start, the control
        // centre and the glyphs above are unaffected.
        try {
            this.#spotlight = new Spotlight(this);
        } catch (e) {
            console.error(`macos-control-center: Spotlight failed to start: ${e.message}`);
            this.#spotlight = null;
        }

        // Glass for Dash to Dock, if it is there. Independent of everything above.
        try {
            this.#docks = new DockWatcher(this.path);
            this.#docks.start();
        } catch (e) {
            console.error(`macos-control-center: dock glass failed to start: ${e.message}`);
            this.#docks = null;
        }

        // The Shell moves the clock back to the centre box on every session
        // mode change (lock, unlock, login screen), so the arrangement has to
        // be re-applied. #arrangeStatusArea() itself ignores those modes.
        Main.sessionMode.connectObject('updated',
            () => this.#arrangeStatusArea(),
            this);
    }

    disable() {
        Main.sessionMode.disconnectObject(this);

        this.#docks?.stop();
        this.#docks = null;

        this.#spotlight?.destroy();
        this.#spotlight = null;

        this.#restoreClock();

        for (const indicator of this.#indicators)
            indicator.destroy();
        this.#indicators = [];

        // PanelMenu.Button.destroy() destroys the button and its container,
        // which is what removes it from the status area.
        this.#panel?.destroy();
        this.#panel = null;

        // Last: every surface above has let go of the settings by now.
        setGlassSettings(null);
        setIconsPath(null);
    }

    /**
     * The status area lays its items out in insertion order, so the arrangement
     * of the reference is a matter of appending: Wi-Fi and Bluetooth glyphs,
     * battery glyph, control centre, then the clock, which ends up at the far
     * right of the bar with the control centre directly to its left.
     *
     * Only the normal session is arranged. The lock screen and the login screen
     * have their own panel layout (and no glyphs of ours), and the Shell
     * rebuilds theirs on every mode change anyway.
     */
    #arrangeStatusArea() {
        if (!Main.sessionMode?.isPrimary)
            return;

        const rightBox = Main.panel._rightBox;
        const clock = Main.panel.statusArea.dateMenu?.container ?? null;

        if (!rightBox)
            return;

        // Where the clock came from, so disable() can hand it back. Clutter has
        // no index getter, so the index comes from the parent's children.
        if (clock && !this.#clockHome) {
            const home = clock.get_parent();
            if (home)
                this.#clockHome = [home, home.get_children().indexOf(clock)];
        }

        const group = [
            ...this.#indicators.map(indicator => indicator.container),
            this.#panel?.container,
            clock,
        ];

        for (const actor of group) {
            if (!actor)
                continue;

            // A reparent has to go through remove_child(), and appending in this
            // order is what establishes the arrangement.
            actor.get_parent()?.remove_child(actor);
            rightBox.add_child(actor);
        }
    }

    /** Gives the clock back to the box it was in before the first arrange. */
    #restoreClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        const home = this.#clockHome;
        this.#clockHome = null;

        if (!clock || !home)
            return;

        const [box, index] = home;
        if (clock.get_parent() === box)
            return;

        clock.get_parent()?.remove_child(clock);
        box.insert_child_at_index(clock, index);
    }
}
