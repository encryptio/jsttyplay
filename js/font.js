// TODO: look into using drawRect for backgrounds, to only need a colorMap for every foreground color
var FontRenderer = (function(){
    var fonts = {
        /*
         * name: {
         *     'image': Image(),
         *     'loaded': true,
         *     'colorMaps': {
         *         "$fg/$bg": HTMLCanvasElement,
         *         ...
         *     },
         *     'loadedCallback': function () { ... }, # goes away after loaded
         *     'loadedImage': true, # goes away after loaded
         *     'loadedChars': true, # goes away after loaded
         *     'charsXHR': new XMLHttpRequest(), # goes away after loaded
         *     'chars': {
         *         codepoint: index in image,
         *         ...
         *     },
         *     'charWidth': number,
         *     'charHeight': number,
         *     'charCount': number,
         * }
         */
    };
    var substitutes = {
    };

    var missingCode = '?'.charCodeAt(0);

    return {
        loadFont: function (name, cb) {
            if ( fonts[name] ) return;

            var f = fonts[name] = {
                    image: new Image(),
                    loaded: false,
                    loadedImage: false,
                    loadedChars: false,
                    charsXHR: new XMLHttpRequest(),
                    loadedCallback: cb,
                    'chars': { },
                    'colorMaps': { }
                };

            f.image.onload = function () {
                FontRenderer.loadedFontImage(name);
            };
            f.image.src = 'fonts/' + name + '.png';

            var r = f.charsXHR;
            r.open('GET', 'fonts/' + name + '.txt', true);
            r.onreadystatechange = function () {
                if ( r.readyState == 4 ) {
                    if ( r.status != 200 ) {
                        alert("Couldn't load font stats file: " + r.statusText);
                        throw "Couldn't load font stats file: " + r.statusText;
                    } else {
                        FontRenderer.loadedStatsFile(name);
                    }
                }
            };
            r.send(null);
        },

        drawChar: function (ctx, font, ch, x, y, fg, bg) {
            var f = fonts[font];
            if ( !f )
                throw "Font is not loaded: " + font;

            var codepoint = ch.charCodeAt(0);

            var idx;
            if ( typeof(f.chars[codepoint]) != 'undefined' ) {
                idx = f.chars[codepoint];
            } else if ( typeof(substitutes[codepoint]) != 'undefined' ) {
                if ( typeof(f.chars[substitutes[codepoint]]) != 'undefined' ) {
                    idx = f.chars[substitutes[codepoint]];
                }
            }

            if ( typeof idx == 'undefined' ) {
                if ( typeof(f.chars[missingCode]) != 'undefined' ) {
                    idx = f.chars[missingCode];
                } else {
                    throw "Can't draw \""+ch+"\", it is not mapped and neither is the missing character";
                }
            }

            ctx.drawImage(FontRenderer.getFontColorMap(font, fg, bg), idx*f.charWidth, 0, f.charWidth, f.charHeight, x, y, f.charWidth, f.charHeight);
        },

        drawString: function (ctx, font, str, x, y, fg, bg) {
            for (var i = 0; i < str.length; i++) {
                FontRenderer.drawChar(ctx, font, str.charAt(i), x, y, fg, bg);
                x += fonts[font].charWidth;
            }
        },

        getFontWidth: function (font) {
            if ( fonts[font] )
                return fonts[font].charWidth;
            return undefined;
        },

        getFontHeight: function (font) {
            if ( fonts[font] )
                return fonts[font].charHeight;
            return undefined;
        },

        ////////////////////////////////////////////////////////////////////////////////
        // Private

        getFontColorMap: function (name, fg, bg) {
            var mapstr = fg + "/" + bg;
            if ( fonts[name].colorMaps[mapstr] )
                return fonts[name].colorMaps[mapstr];

            var f = fonts[name];

            var w = f.image.naturalWidth;
            var h = f.image.naturalHeight;

            var cv = document.createElement('canvas');
            cv.setAttribute('width',  w);
            cv.setAttribute('height', h);

            var ctx = cv.getContext('2d');
            ctx.drawImage(f.image, 0, 0);

            var input  = ctx.getImageData(0, 0, w, h);
            var output = ctx.createImageData(w, h);

            var iData = input.data;
            var oData = output.data;

            // TODO: fix on non-one-to-one displays

            fg = FontRenderer.parseColor(fg);
            bg = FontRenderer.parseColor(bg);

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

            fonts[name].colorMaps[mapstr] = cv;

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

        loadedFontImage: function (name) {
            var f = fonts[name];

            f.charHeight = f.image.naturalHeight;

            f.loadedImage = true;
            if ( f.loadedChars )
                FontRenderer.loadedFont(name);
        },

        loadedStatsFile: function (name) {
            var f = fonts[name];

            f.loadedChars = true;

            var text = f.charsXHR.responseText;
            var i = 0;
            text.split("\n").forEach(function(v){
                    if ( v.length ) {
                        if ( ! /^\d+$/.exec(v) ) {
                            alert("Stats file is corrupt, line=\""+v+"\"");
                            throw "Stats file is corrupt, line=\""+v+"\"";
                        }
                        f.chars[v] = i++;
                    }
                });

            f.charCount = i;

            if ( f.loadedImage )
                FontRenderer.loadedFont(name);
        },

        loadedFont: function (name) {
            var f = fonts[name];
            f.loaded = true;

            var cb = f.loadedCallback;

            f.charWidth = f.image.naturalWidth / f.charCount;
            if ( f.charWidth != Math.floor(f.charWidth) ) {
                throw "font loading of \""+name+"\" failed: image width is not a multiple of the character count (image width = " + f.image.naturalWidth + ", character count = " + f.charCount + ")";
            }

            delete f.loadedImage;
            delete f.loadedChars;
            delete f.loadedCallback;
            delete f.charsXHR;

            cb();
        },
    };
})();

