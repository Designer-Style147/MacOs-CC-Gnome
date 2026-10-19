// SPDX-License-Identifier: MIT
//
// ESM entry point. Everything is injected in enable() and torn down in
// disable(); the panel owns all of its own resources (proxies, GSettings,
// Gvc mixer, MPRIS subscription) so that no object outlives the extension.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ControlCenterPanel} from './controlCenterPanel.js';

export default class ControlCenterExtension extends Extension {
    #panel = null;

    enable() {
        this.#panel = new ControlCenterPanel(this);

        // `position` groups the indicator with other right-side items.
        Main.panel.addToStatusArea(this.uuid, this.#panel, 0, 'right');
    }

    disable() {
        this.#panel?.destroy();
        this.#panel = null;
    }
}
