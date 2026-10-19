// SPDX-License-Identifier: MIT
//
// Real Liquid Glass for this extension's surfaces, built on the renderer of the
// Liquid Glass extension (vendored in ./lg, MIT, see lg/README.md).
//
// How one surface works
// ---------------------
// One glass actor covers a whole monitor and sits in the scene graph just below
// the surface it serves. While the stage is painted it copies what is behind
// itself, blurs the copy, and draws glass.frag over it: refraction at the
// edge, chromatic fringing, rim light, tint. Instead of one rounded rectangle
// it draws up to MAX_REGIONS of them from the same copy, which is how every
// bubble of the control centre or of Spotlight gets a piece of glass of its own
// for the price of one copy and one blur.
//
// The regions are rectangles in stage coordinates taken from the bubbles
// themselves, every frame, so the glass follows whatever they do: the menu
// opening, the cascade, a press.
//
// Where it cannot run (GNOME 45, a Shell without the Cogl API it needs) the
// module reports `glassAvailable = false` and the callers keep their plain blur.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PREFIX = '[macos-control-center/glass]';

/** Everything taken from ./lg, or null when it cannot be used. */
let Lg = null;
try {
    const [backdrop, bounds, geometry, allocation, version] = await Promise.all([
        import('./lg/rendering/backdropGlass.js'),
        import('./lg/actors/glassBounds.js'),
        import('./lg/actors/geometry.js'),
        import('./lg/actors/allocation.js'),
        import('./lg/shellVersion.js'),
    ]);

    // The renderer is written for GNOME 46 and later.
    if (version.SHELL_MAJOR >= 46) {
        Lg = {
            BackdropGlass: backdrop.BackdropGlass,
            placeScreenGlass: bounds.placeScreenGlass,
            getTransformedRect: geometry.getTransformedRect,
            ensureGlassAllocated: allocation.ensureGlassAllocated,
        };
    }
} catch (e) {
    console.warn(`${LOG_PREFIX} the glass renderer cannot be loaded, using plain blur: ${e.message}`);
}

/** Whether real glass can be used on this Shell. */
export const glassAvailable = Lg !== null;

/** Room (px) the shader keeps around every region for the refraction and the blur. */
const PADDING = 20;

/** glass.frag's MAX_GLASS_REGIONS. */
const MAX_REGIONS = 16;

/** The default look: a fairly strong white tint, for a bright glass. */
const DEFAULT_MATERIAL = {
    tint: [1, 1, 1],
    tintStrength: 0.36,
    cornerRadius: 18,
    blurRadius: 8,
    brightness: 1.0,
    saturation: 1.5,
    contrast: 1.0,
};

/**
 * Whether a rect [x, y, w, h] can be drawn.
 * @param {number[]} rect
 */
function usable(rect) {
    return rect.every(Number.isFinite) && rect[2] >= 1 && rect[3] >= 1;
}

/**
 * The glass behind a set of rectangles. It is only a drawing layer: the owner
 * adds `actor` to the scene, calls sync() once per frame while it is shown, and
 * destroys it.
 */
export class GlassSurface {
    #glass;
    #regionTint;

    /**
     * @param {object} params
     * @param {string} params.path the extension's directory, where shaders/ lives
     * @param {string} params.owner a name for the log
     * @param {object} [params.material] overrides of DEFAULT_MATERIAL
     */
    constructor({path, owner, material = {}}) {
        const look = {...DEFAULT_MATERIAL, ...material};
        this.#regionTint = look.tint;

        // The glass starts at 1x1: a 0x0 actor with a shader crashes Cogl.
        this.#glass = new Lg.BackdropGlass({extensionPath: path, owner});
        this.#glass.set_size(1, 1);
        this.#glass.set_pivot_point(0, 0);
        this.#glass.hide();

        this.#glass.setPadding(PADDING);
        this.#glass.setIsDock(false);
        this.#glass.setTintColor(...look.tint);
        this.#glass.setTintStrength(look.tintStrength);
        this.#glass.setCornerRadius(look.cornerRadius);
        this.#glass.setBrightness(look.brightness);
        this.#glass.setSaturation(look.saturation);
        this.#glass.setContrast(look.contrast);
        this.#glass.setBlurRadius(look.blurRadius);
        this.#glass.setMultiRegionMode(true);
    }

    /** @returns {Clutter.Actor} the actor to put into the scene */
    get actor() {
        return this.#glass;
    }

    /**
     * Whether the shaders are loaded. Until then nothing is drawn, so the owner
     * keeps its own fills and only drops them once this is true.
     */
    get ready() {
        return this.#glass._shadersLoaded === true;
    }

    /** @param {number} opacity 0 to 255: the glass fades with whatever it serves */
    setOpacity(opacity) {
        if (this.#glass.opacity !== opacity)
            this.#glass.opacity = opacity;
    }

    /**
     * Draws a piece of glass behind each rect. Call it every frame, after the
     * rects are known and before the frame is painted.
     *
     * @param {number[][]} rects [x, y, w, h] in stage coordinates
     * @param {{x: number, y: number, width: number, height: number}} monitor
     * @param {[number, number]} origin where the glass actor goes in its parent:
     *        the monitor's position when the parent is the stage's top group, or
     *        [0, 0] inside a parent that already sits on the monitor
     */
    sync(rects, monitor, origin) {
        const glass = this.#glass;
        const drawable = rects.filter(usable).slice(0, MAX_REGIONS);

        if (drawable.length === 0) {
            if (glass.visible)
                glass.hide();
            return;
        }

        // Region rects are monitor-local and include the shader padding.
        const regions = drawable.map(([x, y, w, h]) => ({
            x: x - monitor.x - PADDING,
            y: y - monitor.y - PADDING,
            w: w + PADDING * 2,
            h: h + PADDING * 2,
            tintR: this.#regionTint[0],
            tintG: this.#regionTint[1],
            tintB: this.#regionTint[2],
            baseStrength: 0,
        }));

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const region of regions) {
            minX = Math.min(minX, region.x);
            minY = Math.min(minY, region.y);
            maxX = Math.max(maxX, region.x + region.w);
            maxY = Math.max(maxY, region.y + region.h);
        }

        if (!glass.visible)
            glass.show();

        glass.setGlassRegions(regions);
        Lg.placeScreenGlass(glass, origin[0], origin[1], monitor.width, monitor.height,
            {x: minX, y: minY, w: maxX - minX, h: maxY - minY});
        glass.setResolution(monitor.width, monitor.height);

        Lg.ensureGlassAllocated(glass);
        // After the geometry setters, so the relays cover this frame's rects.
        glass.syncSources();
    }

    hide() {
        if (this.#glass.visible)
            this.#glass.hide();
    }

    destroy() {
        this.#glass.cleanup();
        this.#glass.destroy();
        this.#glass = null;
    }
}

/**
 * An actor's on-screen rect [x, y, w, h] with every ancestor transform applied,
 * which is what the glass has to follow while a menu or an animation scales it.
 *
 * @param {Clutter.Actor} actor
 * @returns {number[]}
 */
export function screenRect(actor) {
    return Lg.getTransformedRect(actor);
}

/**
 * Runs `step` once per stage frame, from before the frame is laid out and
 * painted, which is when the glass must be told where its regions are. It does
 * not ask for frames of its own: an idle stage stays idle.
 */
export class FrameLoop {
    #step;
    #signalId = 0;
    #laterId = 0;
    #lastUs = 0;
    #failed = false;

    /** @param {() => void} step */
    constructor(step) {
        this.#step = step;
    }

    start() {
        if (this.#signalId)
            return;

        this.#signalId = global.stage.connect('before-update', () => this.#tick());
        // The frame the loop starts in has already begun.
        this.#laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.#laterId = 0;
            this.#tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this.#signalId) {
            global.stage.disconnect(this.#signalId);
            this.#signalId = 0;
        }
        if (this.#laterId) {
            global.compositor.get_laters().remove(this.#laterId);
            this.#laterId = 0;
        }
    }

    /** Runs the step now, outside the frame clock. */
    runNow() {
        this.#run();
    }

    #tick() {
        // Several stage views update in one frame; the step runs once.
        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this.#lastUs < 4000)
            return;
        this.#lastUs = nowUs;
        this.#run();
    }

    #run() {
        try {
            this.#step();
        } catch (e) {
            // One failure must not stop the glass following; it is logged once.
            if (!this.#failed) {
                this.#failed = true;
                console.warn(`${LOG_PREFIX} sync failed: ${e.message}`);
            }
        }
    }
}

/**
 * The monitor a menu or an overlay is on.
 *
 * @param {Clutter.Actor} actor
 * @returns {object}
 */
export function monitorOf(actor) {
    const index = Main.layoutManager.findIndexForActor(actor);
    return Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
}

/**
 * A surface for a PopupMenu with no sheet of its own: the glass sits in the top
 * group just below the menu, and follows `collect()`'s bubbles while it is open.
 * Nothing is created until the menu is first opened.
 */
export class MenuGlass {
    #params;
    #surface = null;
    #loop = null;
    #menuRoot = null;
    #active = false;

    /**
     * @param {object} params
     * @param {string} params.path the extension's directory
     * @param {string} params.owner a name for the log
     * @param {import('resource:///org/gnome/shell/ui/popupMenu.js').PopupMenu} params.menu
     * @param {() => Clutter.Actor[]} params.collect the bubbles to put glass behind
     * @param {(active: boolean) => void} params.onActive called when glass starts or stops
     * @param {object} [params.material]
     */
    constructor(params) {
        this.#params = params;
        params.menu.connectObject('open-state-changed',
            (_menu, open) => (open ? this.#start() : this.#stop()), this);
    }

    #start() {
        const {path, owner, menu, material, onActive} = this.#params;

        // The nearest ancestor that sits directly in the top group.
        let root = menu.actor;
        while (root.get_parent() && root.get_parent() !== Main.uiGroup)
            root = root.get_parent();
        if (root.get_parent() !== Main.uiGroup)
            return;

        if (!this.#surface) {
            this.#surface = new GlassSurface({path, owner, material});
            this.#loop = new FrameLoop(() => this.#sync());
        }

        this.#menuRoot = root;
        const glass = this.#surface.actor;
        if (glass.get_parent() !== Main.uiGroup)
            Main.uiGroup.insert_child_below(glass, root);
        else
            Main.uiGroup.set_child_below_sibling(glass, root);

        this.#loop.start();
    }

    #stop() {
        this.#loop?.stop();
        this.#surface?.hide();
        this.#setActive(false);
    }

    /**
     * The owner drops its own fills only while the glass is really drawing, and
     * is told again on every change: its content may have been built after the
     * menu opened.
     *
     * @param {boolean} active
     */
    #setActive(active) {
        if (this.#active === active)
            return;
        this.#active = active;
        this.#params.onActive(active);
    }

    #sync() {
        const {menu, collect} = this.#params;
        const root = this.#menuRoot;

        if (!menu.actor.mapped || !root) {
            this.#surface.hide();
            return;
        }

        // The Shell may reorder the top group; the glass stays just below the menu.
        if (root.get_previous_sibling() !== this.#surface.actor)
            Main.uiGroup.set_child_below_sibling(this.#surface.actor, root);

        const rects = [];
        for (const actor of collect()) {
            if (!actor.visible || !actor.mapped)
                continue;
            // A bubble fading in (the opening cascade) has no glass until it shows.
            if (actor.get_paint_opacity() < 12)
                continue;
            rects.push(screenRect(actor));
        }

        const monitor = monitorOf(menu.actor);
        this.#surface.setOpacity(root.get_paint_opacity());
        this.#surface.sync(rects, monitor, [monitor.x, monitor.y]);
        this.#setActive(this.#surface.ready && rects.length > 0);
    }

    destroy() {
        this.#params.menu.disconnectObject(this);
        this.#loop?.stop();
        this.#loop = null;
        this.#surface?.destroy();
        this.#surface = null;
        this.#menuRoot = null;
    }
}
