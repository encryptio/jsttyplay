// TODO: look into using drawRect for backgrounds, to only need a colorMap for every foreground color
var VTFont = (function(){
    ////////////////////////////////////////////////////////////////////////////////
    // Font loader

    var fonts = { };
    var fonts_loading = { };

    var base = "./fonts/";
    var setBase = function (baseurl) {
        base = baseurl;
    };

    var load = function (name, cb) {
        if ( fonts_loading[name] ) {
            fonts_loading[name].callbacks.push(cb);
            return;
        }

        var f = fonts_loading[name] = {
                image: new Image(),
                loadedImage: false,
                loadedChars: false,
                charsXHR: new XMLHttpRequest(),
                callbacks: [cb],
            };

        // todo: where's an error handler?
        f.image.onload = function () {
            f.loadedImage = true;
            if ( f.loadedChars )
                loadedFont(name);
        };
        f.image.src = base + name + '.png';

        var r = f.charsXHR;
        r.open('GET', base + name + '.txt', true);
        r.onreadystatechange = function () {
            if ( r.readyState == 4 ) {
                if ( r.status != 200 ) {
                    f.callbacks.forEach(function(cb){
                        cb(null, "Couldn't load stats file");
                    });
                    delete fonts_loading[name];
                } else {
                    f.loadedChars = true;
                    if ( f.loadedImage )
                        loadedFont(name);
                }
            }
        };
        r.send(null);
    };

    var loadedFont = function (name) {
        var fl = fonts_loading[name];
        fonts[name] = new Font(name, fl.image, fl.charsXHR.responseText);
        delete fonts_loading[name];
        fl.callbacks.forEach(function(cb){
                cb(fonts[name], null);
            });
    };

    var open = function (name, cb) {
        if ( fonts[name] ) {
            cb(fonts[name], null);
        } else {
            load(name, cb);
        }
    };

    ////////////////////////////////////////////////////////////////////////////////
    // Font drawer

    var Font = function (name, image, stats) {
        fonts[name] = this;
        this.image = image;
        var chars = this.chars = { };
        this.colorMaps = { };

        var i = 0;
        stats.split("\n").forEach(function(v){
                if ( v.length ) {
                    if ( ! /^\d+$/.exec(v) ) {
                        throw "Stats file is corrupt, line=\""+v+"\"";
                    }
                    chars[v] = i++;
                }
            });

        this.charCount = i;

        this.charHeight = this.image.naturalHeight;
        this.charWidth = this.image.naturalWidth / this.charCount;
        if ( this.charWidth != Math.floor(this.charWidth) )
            throw "font loading of \""+name+"\" failed: image width is not a multiple of the character count (image width = " + this.image.naturalWidth + ", character count = " + this.charCount + ")";

        this.chunkWidth = Math.ceil(8192 / (this.charWidth * this.charHeight));
    };

    Font.prototype = {
        drawChar: function (ctx, ch, x, y, fg, bg) {
            var codepoint = ch.charCodeAt(0);

            var idx;
            if ( typeof(this.chars[codepoint]) != 'undefined' ) {
                idx = this.chars[codepoint];
            } else if ( typeof(substitutes[codepoint]) != 'undefined' ) {
                if ( typeof(this.chars[substitutes[codepoint]]) != 'undefined' ) {
                    idx = this.chars[substitutes[codepoint]];
                }
            }

            if ( typeof idx == 'undefined' ) {
                if ( typeof(this.chars[missingCode]) != 'undefined' ) {
                    idx = this.chars[missingCode];
                } else {
                    throw "Can't draw \""+ch+"\", it is not mapped and neither is the missing character";
                }
            }

            var chunk = Math.floor(idx/this.chunkWidth);
            var offset = idx - chunk*this.chunkWidth;

            ctx.drawImage(this.getFontColorMap(fg, bg, chunk), offset*this.charWidth, 0, this.charWidth, this.charHeight, x, y, this.charWidth, this.charHeight);
        },

        ////////////////////////////////////////////////////////////////////////////////
        // Private

        getFontColorMap: function (fg, bg, chunk) {
            var mapstr = fg + "/" + bg + "/" + chunk;
            if ( this.colorMaps[mapstr] )
                return this.colorMaps[mapstr];

            var w = this.charWidth * this.chunkWidth;
            var h = this.image.naturalHeight;

            var xoff = chunk * w;
            if ( xoff + w > this.image.naturalWidth )
                w = this.image.naturalWidth - xoff;

            var cv = document.createElement('canvas');
            cv.setAttribute('width',  w);
            cv.setAttribute('height', h);

            var ctx = cv.getContext('2d');
            ctx.drawImage(this.image, xoff, 0, w, h, 0, 0, w, h);

            var input  = ctx.getImageData(0, 0, w, h);
            var output = ctx.createImageData(w, h);

            var iData = input.data;
            var oData = output.data;

            // TODO: fix on non-one-to-one displays

            fg = this.parseColor(fg);
            bg = this.parseColor(bg);

            for (var y = 0; y < h; y++)
                for (var x = 0; x < w; x++) {
                    var idx = (y*w+x)*4;
                    if ( iData[idx] > 127 ) {
                        oData[idx  ] = bg[0];
                        oData[idx+1] = bg[1];
                        oData[idx+2] = bg[2];
                        oData[idx+3] = 255;
                    } else {
                        oData[idx  ] = fg[0];
                        oData[idx+1] = fg[1];
                        oData[idx+2] = fg[2];
                        oData[idx+3] = 255;
                    }
                }

            ctx.putImageData(output, 0, 0);

            this.colorMaps[mapstr] = cv;

            return cv;
        },

        parseColor: function (color) {
            var m;
            if ( m = (/^(\d+),(\d+),(\d+)$/.exec(color)) ) {
                return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
            } else {
                throw "Can't parse color \"" + color + "\"";
            }
        },
    };

    return {
        open: open,
        setBase: setBase,
        Font: Font,
    };
})();

