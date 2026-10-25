// SPDX-License-Identifier: MIT
//
// Liquid Glass for the dock. A port of the dock support of the Liquid Glass
// extension (src/dockManager.ts and src/dockWatcher.ts, MIT, see lg/README.md),
// on the glass renderer vendored in ./lg.
//
// Which docks
// -----------
// Dash to Dock, and the Ubuntu Dock, which is the same code under the same actor
// names. GNOME's own dash lives in the overview and is not touched. If neither
// dock is running nothing here does anything.
//
// How it works
// ------------
// The dock keeps working as it does. Its own background (the `dash-background`
// actor and the CSS of its container) is made transparent, and one glass actor,
// the size of the monitor, sits in the top group just below the dock. Every frame
// the glass is told where the dock's background is, so it follows the dock when
// it hides, slides in, or is resized. A hook at paint time corrects the position
// again for a dock that moved after the frame was laid out.
//
// The dock's margin from the screen edge, its size and its position are the dock
// extension's own settings; this only gives it glass.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    chosenLook,
    chosenSmoothing,
    FrameLoop,
    glassAvailable,
    glassModules,
    glassSetting,
    onGlassSettingsChanged,
} from './glassSurface.js';

const LOG_PREFIX = '[macos-control-center/dock]';

/** Room (px) the shader keeps around the glass for its edge effects. */
const PADDING = 20;

/** The glass draws only this far around the dock, so its shadow is not cut off. */
const CLIP_PADDING = 200;

/** CSS class that clears the dock's own background while it has glass. */
const TRANSPARENT_CLASS = 'cc-dock-transparent';

/** Dash to Dock may start after us, and recreates its dock for some settings. */
const SEARCH_DELAY_MS = 2000;
const RESCAN_INTERVAL_MS = 2000;
const RESCAN_IDLE_TICKS = 2;

/** A light, thin glass, like the dock of macOS 26. */
const DOCK_MATERIAL = {
    tint: [1, 1, 1],
    tintStrength: 0.14,
    blurRadius: 6,
    brightness: 1.0,
    saturation: 1.5,
    cornerRadius: 24,
};

/**
 * @param {Clutter.Actor} actor
 * @returns {{absX: number, absY: number, baseW: number, baseH: number}}
 */
function actorBounds(actor) {
    const [baseW, baseH] = actor.get_size();
    const [absX, absY] = actor.get_transformed_position();
    return {absX, absY, baseW, baseH};
}

/** The glass behind one dock. */
class DockGlass {
    #path;
    #container;
    #glass = null;
    #loop = null;
    #parent = null;
    #live = null;
    #active = false;
    #unsubscribe;

    /**
     * @param {string} path the extension's directory
     * @param {St.Widget} container Dash to Dock's `dashtodockDashContainer`
     */
    constructor(path, container) {
        this.#path = path;
        this.#container = container;

        this.#unsubscribe = onGlassSettingsChanged(() => this.#settingsChanged());
        this.#settingsChanged();
    }

    /** Glass comes and goes with the setting, and follows the look chosen. */
    #settingsChanged() {
        const enabled = glassSetting('dock-glass', true);

        if (enabled && !this.#active)
            this.#attach();
        else if (!enabled && this.#active)
            this.#detach();

        if (this.#active)
            this.#applyLook();
    }

    #attach() {
        const Lg = glassModules();
        if (!Lg)
            return;

        // The nearest ancestor that sits directly in the top group.
        let root = this.#container;
        while (root.get_parent() && root.get_parent() !== Main.uiGroup)
            root = root.get_parent();
        if (root.get_parent() !== Main.uiGroup)
            return;

        try {
            this.#glass = new Lg.BackdropGlass({extensionPath: this.#path, owner: 'dock'});
        } catch (e) {
            console.warn(`${LOG_PREFIX} could not create the glass: ${e.message}`);
            return;
        }

        const glass = this.#glass;
        glass.set_size(1, 1);
        glass.hide();
        Main.uiGroup.insert_child_below(glass, root);

        glass.setPadding(PADDING);
        glass.setIsDock(true);
        glass.setContrast(1);
        glass.setTintColor(...DOCK_MATERIAL.tint);
        // After the frame is laid out the dock may have moved again; this puts the
        // glass where the dock is at the moment it is painted.
        glass.setLiveGeometryHook(() => this.#syncLive());

        // The dock's own background steps aside.
        this.#container.add_style_class_name(TRANSPARENT_CLASS);
        this.#parent = this.#container.get_parent();
        this.#parent?.add_style_class_name(TRANSPARENT_CLASS);

        this.#active = true;
        this.#applyLook();

        this.#loop = new FrameLoop(() => this.#sync());
        this.#loop.start();
    }

    #detach() {
        this.#active = false;
        this.#loop?.stop();
        this.#loop = null;
        this.#live = null;
        this.#liveRef = null;
        this.#glassLast = null;

        try {
            this.#container.remove_style_class_name(TRANSPARENT_CLASS);
            this.#parent?.remove_style_class_name(TRANSPARENT_CLASS);
            for (const child of this.#container.get_children()) {
                if (child.has_style_class_name?.('dash-background'))
                    child.opacity = 255;
            }
        } catch {
            // Dash to Dock may already have destroyed its dock.
        }
        this.#parent = null;

        const glass = this.#glass;
        this.#glass = null;
        if (glass) {
            glass.cleanup();
            glass.destroy();
        }
    }

    destroy() {
        this.#unsubscribe();
        this.#detach();
    }

    /** What the user has set, over the defaults. */
    #applyLook() {
        const glass = this.#glass;
        if (!glass)
            return;

        const look = {...DOCK_MATERIAL, ...chosenLook('dock')};
        glass.setTintStrength(look.tintStrength);
        glass.setBlurRadius(look.blurRadius);
        glass.setBrightness(look.brightness);
        glass.setSaturation(look.saturation);
        glass.setCornerRadius(look.cornerRadius);

        const smoothing = chosenSmoothing();
        if (smoothing !== null) {
            glass._renderer.uniforms.set('corner_smoothing', Math.max(0, Math.min(1, smoothing)));
            glass._renderer._repaintIfDirty?.();
        }
    }

    /**
     * The bounds of what the dock shows as its background, or null while it has
     * none. The `dash-background` actor is that, and is hidden: the glass is the
     * background now.
     */
    #readBounds() {
        const target = this.#container;
        let source = target;

        for (const child of target.get_children()) {
            if (child.has_style_class_name?.('dash-background')) {
                child.opacity = 0;
                source = child;
            }
        }

        const [baseW, baseH] = source.get_size();
        const [absX, absY] = source.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return null;

        // The uncorrected position, which #syncLive() compares against.
        this.#live = {actor: source, rawX: absX, rawY: absY};

        const bounds = {absX, absY, baseW, baseH};
        return source === target
            ? bounds
            : glassModules().dock.clipDockBounds(bounds, actorBounds(target));
    }

    /**
     * Dash to Dock's first running-app indicator, used to balance the gaps around
     * the icons.
     */
    #findReference(actor) {
        if (!actor)
            return null;
        if (actor.toString().includes('IndicatorDrawingArea'))
            return actor;

        for (const child of actor.get_children()) {
            const found = this.#findReference(child);
            if (found)
                return found;
        }
        return null;
    }

    /** Once per frame: where the dock is, and so where the glass goes. */
    #sync() {
        const Lg = glassModules();
        const glass = this.#glass;
        const target = this.#container;

        if (!glass || !target.mapped) {
            glass?.hide();
            this.#glassLast = null;
            return;
        }

        let bounds = this.#readBounds();
        if (!bounds)
            return;

        const index = Main.layoutManager.findIndexForActor(target);
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;

        const edges = Lg.dock.dockEdges(bounds, monitor);
        const reference = this.#findReference(target);
        if (reference)
            bounds = Lg.dock.balanceDockBounds(bounds, actorBounds(reference), edges);

        if (bounds.baseW <= 9 || bounds.baseH <= 9) {
            glass.hide();
            this.#glassLast = null;
            return;
        }

        glass.show();

        // A dock flush against the screen edge is only a few pixels on screen:
        // there is nothing to draw glass on.
        const [visibleW, visibleH] = Lg.dock.visibleDockSize(bounds, monitor);
        glass.opacity = visibleW <= 1 || visibleH <= 1 ? 0 : target.opacity;

        this.#syncGlass(bounds, monitor);
    }

    #glassLast = null;

    /** Puts the monitor-sized glass in place and tells it where the dock is. */
    #syncGlass(bounds, monitor) {
        const Lg = glassModules();
        const glass = this.#glass;
        const {absX, absY, baseW, baseH} = bounds;

        const width = Math.max(1, baseW) + PADDING * 2;
        const height = Math.max(1, baseH) + PADDING * 2;
        // Monitor-local, as the shader uses them.
        const localX = absX - PADDING - monitor.x;
        const localY = absY - PADDING - monitor.y;

        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height}`;
        if (this.#glassLast !== key) {
            glass.remove_transition('size');
            glass.remove_transition('position');
            glass.set_position(monitor.x, monitor.y);
            glass.set_size(monitor.width, monitor.height);
            glass.remove_transition('size');
            glass.remove_transition('position');
            this.#glassLast = key;
        }

        // Draw only around the dock, with room for its shadow.
        Lg.setClipIfChanged(glass,
            localX - CLIP_PADDING, localY - CLIP_PADDING,
            width + CLIP_PADDING * 2, height + CLIP_PADDING * 2);
        glass.setShadowMaxRadius(CLIP_PADDING - 20);

        glass.setResolution(monitor.width, monitor.height);
        glass.setGlassGeometry(localX, localY, width, height);

        const source = this.#live;
        this.#liveRef = source
            ? {actor: source.actor, rawX: source.rawX, rawY: source.rawY,
                rect: [localX, localY, width, height]}
            : null;

        // After the geometry setters, so the relays cover this frame's rect.
        glass.syncSources();
    }

    #liveRef = null;

    /** At paint time: the dock may have moved since the frame was laid out. */
    #syncLive() {
        const reference = this.#liveRef;
        if (!reference || !this.#glass)
            return;

        try {
            const [x, y] = reference.actor.get_transformed_position();
            if (!Number.isFinite(x) || !Number.isFinite(y))
                return;

            this.#glass.setGlassGeometry(
                reference.rect[0] + (x - reference.rawX),
                reference.rect[1] + (y - reference.rawY),
                reference.rect[2], reference.rect[3]);
        } catch {
            // The dock was destroyed under us; the watcher will notice.
        }
    }
}

/**
 * Finds the docks and gives each its glass. Dash to Dock may create its dock after
 * this extension is enabled, and recreates it when the monitors change, when it is
 * enabled again and for some of its settings, so it is looked for after a delay and
 * again whenever one may have appeared.
 */
export class DockWatcher {
    #path;
    #docks = [];
    #searchId = 0;
    #rescanId = 0;
    #monitorsChangedId = 0;
    #childAddedId = 0;

    /** @param {string} path the extension's directory */
    constructor(path) {
        this.#path = path;
    }

    start() {
        if (!glassAvailable)
            return;

        this.#monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this.#scheduleRescan());
        this.#childAddedId = Main.layoutManager.uiGroup.connect('child-added', (_group, child) => {
            if (child.get_name() === 'dashtodockContainer')
                this.#scheduleRescan();
        });

        this.#searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this.#searchId = 0;
            this.#find();
            this.#scheduleRescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this.#monitorsChangedId)
            Main.layoutManager.disconnect(this.#monitorsChangedId);
        if (this.#childAddedId)
            Main.layoutManager.uiGroup.disconnect(this.#childAddedId);
        this.#monitorsChangedId = 0;
        this.#childAddedId = 0;

        if (this.#searchId)
            GLib.source_remove(this.#searchId);
        if (this.#rescanId)
            GLib.source_remove(this.#rescanId);
        this.#searchId = 0;
        this.#rescanId = 0;

        for (const entry of [...this.#docks])
            this.#release(entry);
    }

    /** @returns {St.Widget[]} the docks' containers */
    #containers() {
        const found = [];
        const walk = actor => {
            if (actor === global.window_group)
                return;
            if (actor instanceof St.Widget && actor.get_name() === 'dashtodockDashContainer') {
                found.push(actor);
                return;
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(Main.layoutManager.uiGroup);
        return found;
    }

    /** @returns {boolean} true when a dock was found that had no glass yet */
    #find() {
        let added = 0;

        for (const container of this.#containers()) {
            if (this.#docks.some(entry => entry.container === container))
                continue;

            const entry = {container, glass: new DockGlass(this.#path, container), destroyId: 0};
            entry.destroyId = container.connect('destroy', () => {
                entry.destroyId = 0;
                this.#release(entry);
                this.#scheduleRescan();
            });
            this.#docks.push(entry);
            added++;
        }

        if (added > 0)
            console.log(`${LOG_PREFIX} docks with glass: ${this.#docks.length}`);
        return added > 0;
    }

    #release(entry) {
        this.#docks = this.#docks.filter(candidate => candidate !== entry);
        if (entry.destroyId)
            entry.container.disconnect(entry.destroyId);
        entry.destroyId = 0;
        entry.glass.destroy();
    }

    /** Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new. */
    #scheduleRescan() {
        if (this.#rescanId)
            GLib.source_remove(this.#rescanId);

        let idleTicks = 0;
        this.#rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
            idleTicks = this.#find() ? 0 : idleTicks + 1;
            if (idleTicks < RESCAN_IDLE_TICKS)
                return GLib.SOURCE_CONTINUE;

            this.#rescanId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
