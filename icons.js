// SPDX-License-Identifier: MIT
//
// The extension's own icons (icons/, made by tools/convert_icons.py from the Apple
// glyphs) next to the theme's.
//
// An icon is named either as a theme icon ("bluetooth-symbolic") or as one of ours
// with a prefix: "ext:wifi-3" is icons/cc-wifi-3-symbolic.svg. Where an icon is
// named in the code it can therefore be either, and setIcon() / iconProps() do the
// right thing for each.
//
// Nothing here can leave a button without an icon: if the extension's directory is
// not known or a file is missing, the nearest theme icon is used instead.

import Gio from 'gi://Gio';

const PREFIX = 'ext:';

let iconsPath = null;
const cache = new Map();

/** @param {string|null} path the extension's directory */
export function setIconsPath(path) {
    iconsPath = path;
    cache.clear();
}

/**
 * The theme icon that stands in for one of ours.
 *
 * @param {string} key the name after the prefix
 * @returns {string}
 */
function fallbackFor(key) {
    const battery = /^battery-(\d+)(-charging)?$/.exec(key);
    if (battery)
        return `battery-level-${battery[1]}${battery[2] ?? ''}-symbolic`;

    return {
        'wifi-1': 'network-wireless-signal-weak-symbolic',
        'wifi-2': 'network-wireless-signal-ok-symbolic',
        'wifi-3': 'network-wireless-signal-excellent-symbolic',
        'wifi-error': 'network-wireless-no-route-symbolic',
        'airpods': 'audio-headphones-symbolic',
        'appstore': 'view-app-grid-symbolic',
        'shortcuts': 'system-run-symbolic',
        'folder': 'folder-symbolic',
        'clipboard': 'edit-paste-symbolic',
    }[key] ?? 'image-missing-symbolic';
}

/**
 * The props that make a St.Icon show `name`: {gicon} for one of ours,
 * {icon_name} for a theme icon.
 *
 * @param {string} name
 * @returns {{gicon: Gio.Icon}|{icon_name: string}}
 */
export function iconProps(name) {
    if (!name.startsWith(PREFIX))
        return {icon_name: name};

    const key = name.slice(PREFIX.length);

    if (!cache.has(key)) {
        let icon = null;
        if (iconsPath) {
            const file = Gio.File.new_for_path(`${iconsPath}/icons/cc-${key}-symbolic.svg`);
            if (file.query_exists(null))
                icon = new Gio.FileIcon({file});
        }
        cache.set(key, icon);
    }

    const icon = cache.get(key);
    return icon ? {gicon: icon} : {icon_name: fallbackFor(key)};
}

/**
 * Changes an existing St.Icon to `name`. Only touches it if something changes,
 * so it is cheap to call on every refresh.
 *
 * @param {St.Icon} actor
 * @param {string} name
 */
export function setIcon(actor, name) {
    const props = iconProps(name);

    if (props.gicon) {
        if (actor.gicon !== props.gicon)
            actor.gicon = props.gicon;
        return;
    }

    // A theme icon: the file icon, if any, has to go first, or it would stay.
    if (actor.gicon)
        actor.gicon = null;
    if (actor.icon_name !== props.icon_name)
        actor.icon_name = props.icon_name;
}
