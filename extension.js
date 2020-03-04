/* exported init */
/*
 * Copyright 2014 Red Hat, Inc
 * Copyright 2020 Endless, Inc
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses/>.
 */
const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const Background = imports.ui.background;
const Config = imports.misc.config;
const ExtensionUtils = imports.misc.extensionUtils;
const Layout = imports.ui.layout;
const Main = imports.ui.main;

var IconContainer = GObject.registerClass(
class IconContainer extends St.Widget {
    _init(params) {
        super._init(params);

        this.connect('notify::scale-x', () => {
            this.queue_relayout();
        });
        this.connect('notify::scale-y', () => {
            this.queue_relayout();
        });
    }

    vfunc_get_preferred_width(forHeight) {
        let width = super.vfunc_get_preferred_width(forHeight);
        return width.map(w => w * this.scale_x);
    }

    vfunc_get_preferred_height(forWidth) {
        let height = super.vfunc_get_preferred_height(forWidth);
        return height.map(h => h * this.scale_y);
    }
});

var Watermark = GObject.registerClass({
    Properties: {
        // For compatibility with Meta.BackgroundActor
        'brightness': GObject.ParamSpec.double(
            'brightness', 'brightness', 'brightness',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, 1, 1),
        'vignette-sharpness': GObject.ParamSpec.double(
            'vignette-sharpness', 'vignette-sharpness', 'vignette-sharpness',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, 1, 0),
    },
}, class Watermark extends St.Widget {
    _init(bgManager) {
        this._bgManager = bgManager;
        this._monitorIndex = bgManager._monitorIndex;

        this._watermarkFile = null;
        this._forceWatermarkVisible = false;

        this._settings = ExtensionUtils.getSettings();

        this._settings.connect('changed::watermark-file',
            this._updateWatermark.bind(this));
        this._settings.connect('changed::watermark-size',
            this._updateScale.bind(this));
        this._settings.connect('changed::watermark-position',
            this._updatePosition.bind(this));
        this._settings.connect('changed::watermark-border',
            this._updateBorder.bind(this));
        this._settings.connect('changed::watermark-opacity',
            this._updateOpacity.bind(this));
        this._settings.connect('changed::watermark-always-visible',
            this._updateVisibility.bind(this));

        this._textureCache = St.TextureCache.get_default();
        this._textureCache.connect('texture-file-changed', (cache, file) => {
            if (!this._watermarkFile || !this._watermarkFile.equal(file))
                return;
            this._updateWatermarkTexture();
        });

        super._init({
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
        });
        bgManager._container.add_actor(this);

        this.connect('destroy', this._onDestroy.bind(this));

        this.connect('notify::brightness',
            this._updateOpacity.bind(this));

        let constraint = new Layout.MonitorConstraint({
            index: this._monitorIndex,
            work_area: true,
        });
        this.add_constraint(constraint);

        this._bin = new IconContainer({ x_expand: true, y_expand: true });
        this.add_actor(this._bin);
        this._bin.connect('notify::resource-scale',
            this._updateWatermarkTexture.bind(this));

        this._updateWatermark();
        this._updatePosition();
        this._updateBorder();

        this._bgDestroyedId = bgManager.backgroundActor.connect('destroy',
            this._backgroundDestroyed.bind(this));

        this._bgChangedId = bgManager.connect('changed',
            this._updateVisibility.bind(this));
        this._updateVisibility();
    }

    _loadBrandingFile() {
        const WATERMARK_CUSTOM_BRANDING_FILE = `${Config.LOCALSTATEDIR}/lib/eos-image-defaults/branding/gnome-shell.conf`;

        try {
            let keyfile = new GLib.KeyFile();
            keyfile.load_from_file(WATERMARK_CUSTOM_BRANDING_FILE, GLib.KeyFileFlags.NONE);
            return keyfile.get_string('Watermark', 'logo');
        } catch (e) {
            return null;
        }
    }

    _updateWatermark() {
        let filename = this._settings.get_string('watermark-file');
        let brandingFile = this._loadBrandingFile();

        // If there's no GSettings file, but there is a custom file, use
        // the custom file instead and make sure it is visible
        if (!filename && brandingFile) {
            filename = brandingFile;
            this._forceWatermarkVisible = true;
        } else {
            this._forceWatermarkVisible = false;
        }

        let file = Gio.File.new_for_commandline_arg(filename);
        if (this._watermarkFile && this._watermarkFile.equal(file))
            return;

        this._watermarkFile = file;

        this._updateWatermarkTexture();
    }

    _updateOpacity() {
        this._bin.opacity =
            this._settings.get_uint('watermark-opacity') * this.brightness;
    }

    _getWorkArea() {
        return Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
    }

    _getWidthForRelativeSize(size) {
        let { width } = this._getWorkArea();
        return width * size / 100;
    }

    _updateWatermarkTexture() {
        if (this._icon)
            this._icon.destroy();
        this._icon = null;

        let [valid, resourceScale] = this._bin.get_resource_scale();
        if (!valid)
            return;

        let key = this._settings.settings_schema.get_key('watermark-size');
        let [, range] = key.get_range().deep_unpack();
        let [, max] = range.deep_unpack();
        let width = this._getWidthForRelativeSize(max);

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._icon = this._textureCache.load_file_async(this._watermarkFile, width, -1, scaleFactor, resourceScale);
        this._icon.connect('notify::content',
            this._updateScale.bind(this));
        this._bin.add_actor(this._icon);
    }

    _updateScale() {
        if (!this._icon || this._icon.width === 0)
            return;

        let size = this._settings.get_double('watermark-size');
        let width = this._getWidthForRelativeSize(size);
        let scale = width / this._icon.width;
        this._bin.set_scale(scale, scale);
    }

    _updatePosition() {
        let xAlign, yAlign;
        switch (this._settings.get_string('watermark-position')) {
        case 'center':
            xAlign = Clutter.ActorAlign.CENTER;
            yAlign = Clutter.ActorAlign.CENTER;
            break;
        case 'bottom-left':
            xAlign = Clutter.ActorAlign.START;
            yAlign = Clutter.ActorAlign.END;
            break;
        case 'bottom-center':
            xAlign = Clutter.ActorAlign.CENTER;
            yAlign = Clutter.ActorAlign.END;
            break;
        case 'bottom-right':
            xAlign = Clutter.ActorAlign.END;
            yAlign = Clutter.ActorAlign.END;
            break;
        }
        this._bin.x_align = xAlign;
        this._bin.y_align = yAlign;
    }

    _updateBorder() {
        let border = this._settings.get_uint('watermark-border');
        this.style = 'padding: %dpx;'.format(border);
    }

    _updateVisibility() {
        let { background } = this._bgManager.backgroundActor;
        let defaultUri = background._settings.get_default_value('picture-uri');
        let file = Gio.File.new_for_commandline_arg(defaultUri.deep_unpack());

        let visible;
        if (this._forceWatermarkVisible ||
            this._settings.get_boolean('watermark-always-visible'))
            visible = true;
        else if (background._file)
            visible = background._file.equal(file);
        else // background == NONE
            visible = false;

        this.ease({
            opacity: visible ? 255 : 0,
            duration: Background.FADE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _backgroundDestroyed() {
        this._bgDestroyedId = 0;

        if (this._bgManager._backgroundSource) { // background swapped
            this._bgDestroyedId =
                this._bgManager.backgroundActor.connect('destroy',
                    this._backgroundDestroyed.bind(this));
        } else { // bgManager destroyed
            this.destroy();
        }
    }

    _onDestroy() {
        this._settings.run_dispose();
        this._settings = null;

        if (this._bgDestroyedId)
            this._bgManager.backgroundActor.disconnect(this._bgDestroyedId);
        this._bgDestroyedId = 0;

        if (this._bgChangedId)
            this._bgManager.disconnect(this._bgChangedId);
        this._bgChangedId = 0;

        this._bgManager = null;

        this._watermarkFile = null;
    }
});


class Extension {
    constructor() {
        this._monitorsChangedId = 0;
        this._startupPreparedId = 0;
        this._watermarks = new Set();
    }

    _forEachBackgroundManager(func) {
        Main.overview._bgManagers.forEach(func);
        Main.layoutManager._bgManagers.forEach(func);
    }

    _addWatermark() {
        this._destroyWatermark();
        this._forEachBackgroundManager(bgManager => {
            let watermark = new Watermark(bgManager);
            watermark.connect('destroy', () => {
                this._watermarks.delete(watermark);
            });
            this._watermarks.add(watermark);
        });
    }

    _destroyWatermark() {
        this._watermarks.forEach(l => l.destroy());
    }

    enable() {
        this._monitorsChangedId =
            Main.layoutManager.connect('monitors-changed', this._addWatermark.bind(this));
        this._startupPreparedId =
            Main.layoutManager.connect('startup-prepared', this._addWatermark.bind(this));
        this._addWatermark();
    }

    disable() {
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;

        if (this._startupPreparedId)
            Main.layoutManager.disconnect(this._startupPreparedId);
        this._startupPreparedId = 0;

        this._destroyWatermark();
    }
}

function init() {
    return new Extension();
}
