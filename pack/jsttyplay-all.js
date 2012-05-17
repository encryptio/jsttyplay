
var VTCanvasView = (function(){
    var lowColors = ['0,0,0', '192,0,0', '0,192,0', '192,192,0', '0,0,192', '192,0,192', '0,192,192', '192,192,192'];
    var hiColors  = ['0,0,0', '255,0,0', '0,255,0', '255,255,0', '0,0,255', '255,0,255', '0,255,255', '255,255,255'];

    var cloneArray = function (arr) {
        var out = [];
        for (var i in arr)
            out.push(arr[i]);
        return out;
    };

    return function (cv, opts) {
        var s = this;

        if ( !(cv instanceof HTMLCanvasElement) )
            throw "First argument to VTCanvasView constructor must be an HTMLCanvasElement (was "+cv+")";

        s.lowColors  = cloneArray(lowColors);
        s.hiColors   = cloneArray(hiColors);
        s.fontName   = 'qemu-vgafont';
        s.onReady    = [];
        s.autoResize = true;

        s.cv = cv;

        if ( opts.fontName   ) s.fontName   = opts.fontName;
        if ( opts.autoResize ) s.autoResize = opts.autoResize;
        if ( opts.onReady    ) s.onReady.push(opts.onReady);
        
        s.cursor = {
                cur:   { x: 0, y: 0 },
                drawn: { x: 0, y: 0 }
            };

        s.emu = new VTEmulator({
                change: function (y, minx, maxx) {
                        s.makeSpanDirty(y, minx, maxx);
                    },
                cursor: function (x, y) {
                        if ( x >= s.emu.width ) x = s.emu.width - 1;
                        s.cursor.cur.x = x;
                        s.cursor.cur.y = y;
                    },
                special: function (obj) {
                        if ( obj.thaw ) {
                            for (var y = 0; y < s.emu.height; y++)
                                s.makeSpanDirty(y, 0, s.emu.width-1);
                            s.cursor.cur.x = s.emu.cursor.x;
                            s.cursor.cur.y = s.emu.cursor.y;
                        }
                    },
            });

        s.parser = new VTParser(function () {
                s.emu.handleEvent(Array.prototype.slice.call(arguments));
            });

        s.dirtySpans = [];
        for (var y = 0; y < s.emu.height; y++)
            s.dirtySpans[y] = { min: 0, max: s.emu.width-1 };

        // this callback may be called immediately, so we must make sure
        // everything is set up for it beforehand
        VTFont.open(s.fontName, function (f) {
                s.font = f;
                s.readyCheck();
            });
    };
})();

VTCanvasView.prototype.freeze = function () {
    return {
        emulator: this.emu.freeze(),
        parser: this.parser.freeze()
    };
};

VTCanvasView.prototype.thaw = function (obj) {
    this.emu.thaw(obj.emulator);
    this.parser.thaw(obj.parser);
};

VTCanvasView.prototype.parseData = function (data) {
    this.parser.parse(data);
};

VTCanvasView.prototype.makeSpanDirty = function (y, minx, maxx) {
    if ( y >= this.emu.height || minx < 0 || maxx >= this.emu.width )
        throw "argh";
    var s = this.dirtySpans[y];
    if ( s.min > minx ) s.min = minx;
    if ( s.max < maxx ) s.max = maxx;
}

VTCanvasView.prototype.dirtyMovedCursor = function () {
    var c = this.cursor;
    if ( c.cur.x != c.drawn.x || c.cur.y != c.drawn.y ) {
        this.makeSpanDirty(c.cur.y,   c.cur.x,   c.cur.x);
        this.makeSpanDirty(c.drawn.y, c.drawn.x, c.drawn.x);
        c.drawn.x = c.cur.x;
        c.drawn.y = c.cur.y;
    }
};

VTCanvasView.prototype.draw = function () {
    this.dirtyMovedCursor();

    var ctx = this.cv.getContext('2d');
                
    var cw = this.font.charWidth;
    var ch = this.font.charHeight;

    for (var y = 0; y < this.emu.height; y++) {
        var span = this.dirtySpans[y];
        for (var x = span.min; x <= span.max; x++) {
            var idx = y*this.emu.width+x;

            var bg = this.lowColors[this.emu.scr.c.bcolor[idx]];
            var fg = (this.emu.scr.c.lowintensity[idx] ? this.lowColors : this.hiColors)[this.emu.scr.c.fcolor[idx]];
            var c = this.emu.scr.c.text[idx];

            if ( this.cursor.cur.x == x && this.cursor.cur.y == y ) {
                var nbg = fg;
                var nfg = bg;
                fg = nfg;
                bg = nbg;
            }

            this.font.drawChar(ctx, c, x*cw, y*ch, fg, bg);
        }
        span.min = this.emu.width-1;
        span.max = 0;
    }
}

VTCanvasView.prototype.readyCheck = function () {
    if ( this.font )
        this.ready();
};

VTCanvasView.prototype.ready = function () {
    if ( this.autoResize ) {
        this.cv.setAttribute('width',  this.emu.width  * this.font.charWidth);
        this.cv.setAttribute('height', this.emu.height * this.font.charHeight);
    }
    this.onReady.forEach(function (fn) {
            fn();
        });
    this.draw();
};

var VTEmulator = (function(){
// somewhat vt102, somewhat xterm

function boolToChar(b) {
    return b ? "T" : "F";
}

function unpack_unicode(hex) {
    return String.fromCharCode(parseInt(hex, 16));
}

function cloneObject(input, out) {
    for (var k in out)
        delete out[k];
    for (var k in input)
        out[k] = input[k];
}

function cloneArray(input, out) {
    out.splice(0, out.length);
    for (var i in input)
        out.push(input[i]);
}

function cloneArrayOfObjects(input, out) {
    out.splice(0, out.length);
    for (var i in input) {
        out[i] = { };
        for (var k in input[i])
            out[i][k] = input[i][k];
    }
}

var emu = function (opts) {
    if ( opts.change )
        this.changeCallback = opts.change;

    if ( opts.special )
        this.specialCallback = opts.special;

    if ( opts.output )
        this.outputCallback = opts.output;

    if ( opts.cursor )
        this.cursorCallback = opts.cursor;

    this.width  = opts.width  || 80;
    this.height = opts.height || 24;

    this.initialize();
};

emu.prototype = {
    initialize: function () {
        this.scr = {};
        this.scralt = {};

        // line-wide
        this.scr.lineAttr = [];
        this.scralt.lineAttr = [];

        for (var i = 0; i < this.height; i++) {
            this.scr.lineAttr.push({ width: 'normal', height: 'normal' });
            this.scralt.lineAttr.push({ width: 'normal', height: 'normal' });
        }

        // character-wide
        this.scr.c = {};
        this.scr.c.text = [];
        this.scr.c.bold = [];
        this.scr.c.underline = [];
        this.scr.c.lowintensity = [];
        this.scr.c.blink = [];
        this.scr.c.fcolor = [];
        this.scr.c.bcolor = [];

        this.scralt.c = {};
        this.scralt.c.text = [];
        this.scralt.c.bold = [];
        this.scralt.c.underline = [];
        this.scralt.c.lowintensity = [];
        this.scralt.c.blink = [];
        this.scralt.c.fcolor = [];
        this.scralt.c.bcolor = [];

        for (var i = 0; i < this.width*this.height; i++) {
            this.scr.c.text.push(' ');
            this.scr.c.bold.push(false);
            this.scr.c.underline.push(false);
            this.scr.c.lowintensity.push(true);
            this.scr.c.blink.push(false);
            this.scr.c.fcolor.push(7);
            this.scr.c.bcolor.push(0);

            this.scralt.c.text.push(' ');
            this.scralt.c.bold.push(false);
            this.scralt.c.underline.push(false);
            this.scralt.c.lowintensity.push(true);
            this.scralt.c.blink.push(false);
            this.scralt.c.fcolor.push(7);
            this.scralt.c.bcolor.push(0);
        }

        this.mode = {};
        this.mode.cursorKeyANSI = true;
        this.mode.scroll = 'jump'; // | smooth
        this.mode.reverseScreen = false;
        this.mode.originMode = 'screen'; // | marginHome
        this.mode.autoWrap = true;
        this.mode.autoRepeat = true;
        this.mode.mouseTrackingDown = false;
        this.mode.mouseTrackingUp = false;
        this.mode.currentScreen = 1;
        this.mode.keyboardLocked = false;
        this.mode.insert = false;
        this.mode.localEcho = true;
        this.mode.newLineMode = 'cr'; // | crlf

        this.cursor = {};
        this.cursor.x = 0;
        this.cursor.y = 0;
        this.cursor.bold = false;
        this.cursor.underline = false;
        this.cursor.lowintensity = true;
        this.cursor.blink = false;
        this.cursor.reversed = false; // state, fcolor and bcolor are flipped when this is
        this.cursor.invisible = false; // TODO: implement
        this.cursor.fcolor = 7;
        this.cursor.bcolor = 0;

        this.cursorStack = [];

        this.margins = {};
        this.margins.top = 0;
        this.margins.bottom = this.height-1;

        this.tabs = {};
        for (var t = 0; t < this.width; t++)
            this.tabs[t] = t % 8 == 0;

        this.windowTitle = '';
        this.iconTitle = '';

        this.charsets = {};
        this.charsets.g0 = 'us';
        this.charsets.g1 = 'line';
        this.charsets.active = 'g0';
    },

    freeze: function () {
        var ret = { scr: { lineAttr: [] }, scralt: { lineAttr: [] } };
        cloneArrayOfObjects(this.scr.lineAttr, ret.scr.lineAttr);
        cloneArrayOfObjects(this.scralt.lineAttr, ret.scralt.lineAttr);

        ret.scr.c = { text: [], bold: [], underline: [], lowintensity: [], blink: [], fcolor: [], bcolor: [] };
        cloneArray(this.scr.c.text, ret.scr.c.text);
        cloneArray(this.scr.c.bold, ret.scr.c.bold);
        cloneArray(this.scr.c.underline, ret.scr.c.underline);
        cloneArray(this.scr.c.lowintensity, ret.scr.c.lowintensity);
        cloneArray(this.scr.c.blink, ret.scr.c.blink);
        cloneArray(this.scr.c.fcolor, ret.scr.c.fcolor);
        cloneArray(this.scr.c.bcolor, ret.scr.c.bcolor);

        ret.scralt.c = { text: [], bold: [], underline: [], lowintensity: [], blink: [], fcolor: [], bcolor: [] };
        cloneArray(this.scralt.c.text, ret.scralt.c.text);
        cloneArray(this.scralt.c.bold, ret.scralt.c.bold);
        cloneArray(this.scralt.c.underline, ret.scralt.c.underline);
        cloneArray(this.scralt.c.lowintensity, ret.scralt.c.lowintensity);
        cloneArray(this.scralt.c.blink, ret.scralt.c.blink);
        cloneArray(this.scralt.c.fcolor, ret.scralt.c.fcolor);
        cloneArray(this.scralt.c.bcolor, ret.scralt.c.bcolor);

        ret.mode = { };
        cloneObject(this.mode, ret.mode);

        ret.cursor = { };
        cloneObject(this.cursor, ret.cursor);

        ret.cursorStack = [];
        cloneArrayOfObjects(this.cursorStack, ret.cursorStack);

        ret.margins = { };
        cloneObject(this.margins, ret.margins);

        ret.tabs = { };
        cloneObject(this.tabs, ret.tabs);

        ret.windowTitle = this.windowTitle;
        ret.iconTitle = this.iconTitle;

        ret.charsets = { };
        cloneObject(this.charsets, ret.charsets);

        return ret;
    },

    thaw: function (obj) {
        cloneArrayOfObjects(obj.scr.lineAttr, this.scr.lineAttr);
        cloneArrayOfObjects(obj.scralt.lineAttr, this.scralt.lineAttr);

        cloneArray(obj.scr.c.text, this.scr.c.text);
        cloneArray(obj.scr.c.bold, this.scr.c.bold);
        cloneArray(obj.scr.c.underline, this.scr.c.underline);
        cloneArray(obj.scr.c.lowintensity, this.scr.c.lowintensity);
        cloneArray(obj.scr.c.blink, this.scr.c.blink);
        cloneArray(obj.scr.c.fcolor, this.scr.c.fcolor);
        cloneArray(obj.scr.c.bcolor, this.scr.c.bcolor);

        cloneArray(obj.scralt.c.text, this.scralt.c.text);
        cloneArray(obj.scralt.c.bold, this.scralt.c.bold);
        cloneArray(obj.scralt.c.underline, this.scralt.c.underline);
        cloneArray(obj.scralt.c.lowintensity, this.scralt.c.lowintensity);
        cloneArray(obj.scralt.c.blink, this.scralt.c.blink);
        cloneArray(obj.scralt.c.fcolor, this.scralt.c.fcolor);
        cloneArray(obj.scralt.c.bcolor, this.scralt.c.bcolor);

        cloneObject(obj.mode, this.mode);

        cloneObject(obj.cursor, this.cursor);

        cloneArrayOfObjects(obj.cursorStack, this.cursorStack);

        cloneObject(obj.margins, this.margins);

        cloneObject(obj.tabs, this.tabs);

        this.windowTitle = obj.windowTitle;
        this.iconTitle   = obj.iconTitle;

        cloneObject(obj.charsets, this.charsets);

        this.postSpecial({ 'thaw': 'thaw' });
    },

    charmap: {
        us: { }, // not existing implies consistent with unicode
        uk: {
            '#': unpack_unicode("A3"), // pound symbol
        },
        line: {
            '_': ' ',
            '`': unpack_unicode("2666"), // diamond
            'a': unpack_unicode("2591"), // checkerboard
            'b': unpack_unicode("2409"), // HT
            'c': unpack_unicode("240C"), // FF
            'd': unpack_unicode("240D"), // CR
            'e': unpack_unicode("240A"), // LF
            'f': unpack_unicode("B0"),   // degree symbol
            'g': unpack_unicode("B1"),   // plusminus
            'h': unpack_unicode("2424"), // NL
            'i': unpack_unicode("240B"), // VT
            'j': unpack_unicode("2518"), // corner lr
            'k': unpack_unicode("2510"), // corner ur
            'l': unpack_unicode("250C"), // corner ul
            'm': unpack_unicode("2514"), // corner ll
            'n': unpack_unicode("253C"), // meeting +
            //'o': unpack_unicode(""),   // scan 1 horizontal
            //'p': unpack_unicode(""),   // scan 3 horizontal
            'q': unpack_unicode("2500"), // scan 5 horizontal
            //'r': unpack_unicode(""),   // scan 7 horizontal
            //'s': unpack_unicode(""),   // scan 9 horizontal
            't': unpack_unicode("2524"), // vertical meet right
            'u': unpack_unicode("251C"), // vertical meet left
            'v': unpack_unicode("2534"), // horizontal meet top
            'w': unpack_unicode("252C"), // horizontal meet bottom
            'x': unpack_unicode("2502"), // vertical bar
            'y': unpack_unicode("2264"), // less than or equal to
            'z': unpack_unicode("2265"), // greater than or equal to
            '{': unpack_unicode("3C0"),  // pi
            '|': unpack_unicode("2260"), // not equal to
            '}': unpack_unicode("A3"),   // pound symbol
            '~': unpack_unicode("B7"),   // center dot
        },
    },

    postChange: function (y, minx, maxx) {
        if ( this.changeCallback )
            this.changeCallback(y, minx, maxx);
    },

    postSpecial: function (obj) {
        if ( this.specialCallback )
            this.specialCallback(obj);
    },

    postCursor: function () {
        if ( this.cursorCallback )
            this.cursorCallback(this.cursor.x, this.cursor.y);
    },

    ev_setWindowTitle: function (title) {
        this.windowTitle = title;
        this.postSpecial({ title: title });
    },

    ev_setIconTitle: function (title) {
        this.iconTitle = title;
        this.postSpecial({ title: title });
    },

    ev_setWindowIconTitle: function (title) {
        this.ev_setWindowTitle(title);
        this.ev_setIconTitle(title);
    },

    ev_resetMargins: function () {
        this.ev_setMargins(1,this.height);
    },

    ev_setMargins: function (top, bottom) {
        top -= 1;
        bottom -= 1;

        if ( top+1 >= bottom ) top = bottom-1;

        if ( top < 0 ) top = 0;
        if ( top > this.height-2 ) top = this.height-2;
        if ( bottom < 1 ) bottom = 1;
        if ( bottom > this.height-1 ) bottom = this.height-1;

        if ( top+1 >= bottom )
            throw "numbers do not obey the laws of arithmetic in setMargins";

        this.margins.top = top;
        this.margins.bottom = bottom;

        this.ev_goto('home');
    },

    ev_cursorStack: function (action) {
        if ( action == 'push' ) {
            this.cursorStack.push({
                    x: this.cursor.x,
                    y: this.cursor.y,
                    bold: this.cursor.bold,
                    underline: this.cursor.underline,
                    lowintensity: this.cursor.lowintensity,
                    blink: this.cursor.blink,
                    reversed: this.cursor.reversed,
                    invisible: this.cursor.invisible,
                    fcolor: this.cursor.fcolor,
                    bcolor: this.cursor.bcolor
                });

        } else if ( action == 'pop' ) {
            if ( this.cursorStack.length > 0 )
                this.cursor = this.cursorStack.pop();
            this.postCursor();

        } else {
            throw "Can't do cursorStack action "+action;
        }
    },

    ev_setAttribute: function (attr) {
        if ( attr == 0 ) {
            this.cursor.bold = false;
            this.cursor.underline = false;
            this.cursor.lowintensity = true;
            this.cursor.blink = false;
            this.cursor.reversed = false;
            this.cursor.invisible = false;
            this.cursor.fcolor = 7;
            this.cursor.bcolor = 0;
        } else if ( attr == 1 || attr == 21 ) {
            this.cursor.bold = attr == 1;
        } else if ( attr == 2 || attr == 22 ) {
            this.cursor.lowintensity = attr == 2;
        } else if ( attr == 4 || attr == 24 ) {
            this.cursor.underline = attr == 4;
        } else if ( attr == 5 || attr == 25 ) {
            this.cursor.blink = attr == 5;
        } else if ( attr == 7 || attr == 27 ) {
            if ( (this.cursor.reversed && attr == 7) || (!this.cursor.reversed && attr == 27) ) {
                // do nothing
            } else {
                var b = this.cursor.fcolor;
                var f = this.cursor.bcolor;
                this.cursor.fcolor = f;
                this.cursor.bcolor = b;
                this.cursor.reversed = attr == 7;
            }
        } else if ( attr == 8 || attr == 28 ) {
            this.cursor.invisible = attr == 8;
        } else if ( attr >= 30 && attr < 40 ) {
            this.cursor.fcolor = attr-30;
        } else if ( attr >= 40 && attr <= 49 ) {
            this.cursor.bcolor = attr-40;
        } else {
            console.log("Warning: ignoring setAttribute(" + attr + ")");
        }
    },

    ev_normalString: function (str) {
        for (var i = 0; i < str.length; i++)
            this.ev_normalChar(str[i]);
    },

    ev_normalChar: function (ch) {
        // charmapping
        if ( this.charsets.active &&
                this.charsets[this.charsets.active] &&
                this.charmap[this.charsets[this.charsets.active]] &&
                this.charmap[this.charsets[this.charsets.active]][ch] )
            ch = this.charmap[this.charsets[this.charsets.active]][ch];

        // wrapping
        if ( this.cursor.x == this.width ) {
            // cursor is on the margin, we can't put a character there
            if ( this.mode.autoWrap ) {
                var b = this.mode.originMode == 'screen' ? this.height : this.margins.bottom+1;
                this.cursor.x = 0;
                this.cursor.y++;
                if ( this.cursor.y >= b ) {
                    this.scroll(1);
                    this.cursor.y = b-1;
                }
            } else {
                // temporarily
                this.cursor.x--;
            }
        }

        // put on screen
        if ( this.mode.insert ) {
            // this.scr.c.*;
            var idx = this.cursor.x + this.cursor.y * this.width;
            var rmidx = (this.cursor.y+1) * this.width;
            this.scr.c.text.splice(idx, 0, ch);
            this.scr.c.text.splice(rmidx, 1);
            this.scr.c.bold.splice(idx, 0, this.cursor.bold);
            this.scr.c.bold.splice(rmidx, 1);
            this.scr.c.underline.splice(idx, 0, this.cursor.underline);
            this.scr.c.underline.splice(rmidx, 1);
            this.scr.c.lowintensity.splice(idx, 0, this.cursor.lowintensity);
            this.scr.c.lowintensity.splice(rmidx, 1);
            this.scr.c.blink.splice(idx, 0, this.cursor.blink);
            this.scr.c.blink.splice(rmidx, 1);
            this.scr.c.fcolor.splice(idx, 0, this.cursor.fcolor);
            this.scr.c.fcolor.splice(rmidx, 1);
            this.scr.c.bcolor.splice(idx, 0, this.cursor.bcolor);
            this.scr.c.bcolor.splice(rmidx, 1);
            
            this.postChange(this.cursor.y, this.cursor.x, this.width-1);
        } else {
            // not this.mode.insert -> replace

            this.putChar('set', this.cursor.x, this.cursor.y,
                    ch,
                    this.cursor.bold,
                    this.cursor.underline,
                    this.cursor.lowintensity,
                    this.cursor.blink,
                    this.cursor.fcolor,
                    this.cursor.bcolor);

            this.postChange(this.cursor.y, this.cursor.x, this.cursor.x);
        }

        // stepping
        this.cursor.x++;
        this.postCursor();
    },
    
    ev_specialChar: function (key) {
        switch (key) {
            case 'carriageReturn':
                this.cursor.x = 0;
                this.postCursor();
                break;

            case 'backspace':
                this.cursor.x--;
                if ( this.cursor.x < 0 )
                    this.cursor.x = 0;
                this.postCursor();
                break;

            case 'lineFeed':
            case 'formFeed':
            case 'verticalTab':
                this.cursor.y++;
                if ( this.cursor.y == this.margins.bottom+1 ) {
                    this.scroll(1);
                    this.cursor.y = this.margins.bottom;
                }
                if ( this.cursor.y >= this.height ) {
                    this.cursor.y = this.height-1;
                }
                if ( this.mode.newLineMode == 'crlf' )
                    this.cursor.x = 0;
                this.postCursor();
                break;

            case 'horizontalTab':
                do {
                    this.cursor.x++;
                } while ( this.cursor.x < this.width && !this.tabs[this.cursor.x] );
                this.postCursor();
                break;

            case 'bell':
                this.postSpecial({ 'bell': 'bell' });
                break;

            default:
                console.log("Warning: skipping specialChar event for key "+key);
        }
    },

    ev_arrow: function (dir, count) {
        var t = this.mode.originMode == 'screen' ? 0 : this.margins.top;
        var b = this.mode.originMode == 'screen' ? this.height : this.margins.bottom+1;
        switch ( dir ) {
            case 'up':
                this.cursor.y -= count;
                if ( this.cursor.y < t )
                    this.cursor.y = t;
                this.postCursor();
                break;

            case 'down':
                this.cursor.y += count;
                if ( this.cursor.y >= b )
                    this.cursor.y = b-1;
                this.postCursor();
                break;

            case 'left':
                this.cursor.x -= count;
                if ( this.cursor.x < 0 )
                    this.cursor.x = 0;
                this.postCursor();
                break;

            case 'right':
                this.cursor.x += count;
                if ( this.cursor.x >= this.width )
                    this.cursor.x = this.width-1;
                this.postCursor();
                break;

            default:
                throw "Can't handle arrow event with direction "+dir;
        }
    },

    ev_deleteChars: function (count) {
        var rmidx = this.cursor.x + this.cursor.y * this.width;
        var insidx = (this.cursor.y + 1) * this.width - 2;
        for (var i = 0; i < count; i++) {
            this.scr.c.text.splice(rmidx, 1);
            this.scr.c.text.splice(insidx, 0, ' ');
            this.scr.c.bold.splice(rmidx, 1);
            this.scr.c.bold.splice(insidx, 0, false);
            this.scr.c.underline.splice(rmidx, 1);
            this.scr.c.underline.splice(insidx, 0, false);
            this.scr.c.lowintensity.splice(rmidx, 1);
            this.scr.c.lowintensity.splice(insidx, 0, false);
            this.scr.c.blink.splice(rmidx, 1);
            this.scr.c.blink.splice(insidx, 0, false);
            this.scr.c.fcolor.splice(rmidx, 1);
            this.scr.c.fcolor.splice(insidx, 0, 7);
            this.scr.c.bcolor.splice(rmidx, 1);
            this.scr.c.bcolor.splice(insidx, 0, 0);
        }
        this.postChange(this.cursor.y, this.cursor.x, this.width-1);
    },

    ev_deleteLines: function (count) {
        if ( this.cursor.y > this.margins.bottom ) return;
        if ( this.cursor.y < this.margins.top ) return;

        for (var i = 0; i < count; i++) {
            for (var y = this.cursor.y; y < this.margins.bottom; y++)
                for (var x = 0; x < this.width; x++) {
                    var fromIdx = x + (y+1)*this.width;
                    this.putChar('set', x, y,
                            this.scr.c.text[fromIdx],
                            this.scr.c.bold[fromIdx],
                            this.scr.c.underline[fromIdx],
                            this.scr.c.lowintensity[fromIdx],
                            this.scr.c.blink[fromIdx],
                            this.scr.c.fcolor[fromIdx],
                            this.scr.c.bcolor[fromIdx]
                       );
                }

            for (var x = 0; x < this.width; x++)
                this.scr.c.text[this.margins.bottom*this.width + x] = ' ';

            this.scr.lineAttr.splice(this.margins.bottom, 0, {
                    width: this.scr.lineAttr[this.margins.bottom-1].width,
                    height: this.scr.lineAttr[this.margins.bottom-1].height
                });
            this.scr.lineAttr.splice(this.cursor.y, 1);
        }

        for (var y = this.cursor.y; y <= this.margins.bottom; y++)
            this.postChange(y, 0, this.width-1);
    },

    ev_insertLines: function (count) {
        if ( this.cursor.y > this.margins.bottom ) return;
        if ( this.cursor.y < this.margins.top ) return;

        for (var i = 0; i < count; i++) {
            for (var y = this.margins.bottom; y > this.cursor.y; y--)
                for (var x = 0; x < this.width; x++) {
                    var fromIdx = x + (y-1)*this.width;
                    this.putChar('set', x, y,
                            this.scr.c.text[fromIdx],
                            this.scr.c.bold[fromIdx],
                            this.scr.c.underline[fromIdx],
                            this.scr.c.lowintensity[fromIdx],
                            this.scr.c.blink[fromIdx],
                            this.scr.c.fcolor[fromIdx],
                            this.scr.c.bcolor[fromIdx]
                       );
                }

            for (var x = 0; x < this.width; x++)
                this.putChar('set', x, this.cursor.y, ' ', false, false, true, false, 7, 0);

            this.scr.lineAttr.splice(this.margins.bottom, 1);
            this.scr.lineAttr.splice(this.cursor.y, 0, { width: 'normal', height: 'normal' });
        }

        for (var y = this.cursor.y; y <= this.margins.bottom; y++)
            this.postChange(y, 0, this.width-1);
    },

    ev_index: function (how) {
        switch (how) {
            case 'down':
                if ( this.cursor.y == this.margins.bottom ) {
                    this.scroll(1);
                } else {
                    this.cursor.y++;
                    this.postCursor();
                }
                break;

            case 'up':
                if ( this.cursor.y == this.margins.top ) {
                    this.scroll(-1);
                } else {
                    this.cursor.y--;
                    this.postCursor();
                }
                break;

            case 'nextLine':
                this.ev_index('down');
                this.cursor.x = 0;
                this.postCursor();
                break;

            default:
                throw "Can't index with method "+how;
        }
    },

    ev_originMode: function (mode) {
        this.mode.originMode = mode;
        this.ev_goto('home');
    },

    ev_mode: function (key, value) {
        switch ( key ) {
            case 'insert':
            case 'cursorKeyANSI':
            case 'keypad':
            case 'mouseTrackingUp':
            case 'mouseTrackingDown':
            case 'autoWrap':
            case 'scroll':
                this.mode[key] = value;
                var modeset = {};
                modeset[key] = value;
                this.postSpecial({ 'mode': modeset });
                break;

            case 'currentScreen':
                var old = this.mode.currentScreen;
                if ( old != value ) {
                    var newscr = this.scralt;
                    var newscralt = this.scr;
                    this.scr = newscr;
                    this.newscralt = newscralt;
                    this.mode.currentScreen = value;
                }
                for (var y = 0; y < this.height; y++)
                    this.postChange(y, 0, this.width-1);
                break;

            default:
                console.log("Warning: can't handle mode change '"+key+"' to '"+value+"'");
        }
    },

    ev_eraseInLine: function (how) {
        switch (how) {
            case 'toEnd':
                for (var x = this.cursor.x; x < this.width; x++)
                    this.putChar('set', x, this.cursor.y, ' ', false, false, true, false, 7, 0);
                this.postChange(this.cursor.y, this.cursor.x, this.width-1);
                break;

            case 'toStart':
                for (var x = this.cursor.x; x >= 0; x--)
                    this.putChar('set', x, this.cursor.y, ' ', false, false, true, false, 7, 0);
                this.postChange(this.cursor.y, 0, this.cursor.x);
                break;

            case 'whole':
                for (var x = 0; x < this.width; x++)
                    this.putChar('set', x, this.cursor.y, ' ', false, false, true, false, 7, 0);
                this.postChange(this.cursor.y, 0, this.width-1);
                break;

            default:
                throw "Can't eraseInLine with method '" + how + "'";
        }
    },

    ev_eraseInDisplay: function (how) {
        switch (how) {
            case 'toEnd':
                this.ev_eraseInLine('toEnd');
                for (var y = this.cursor.y+1; y < this.height; y++) {
                    for (var x = 0; x < this.width; x++)
                        this.putChar('set', x, y, ' ', false, false, true, false, 7, 0);
                    this.scr.lineAttr.splice(y, 1, { width: 'normal', height: 'normal' });
                }
                for (var y = this.cursor.y+1; y < this.height; y++)
                    this.postChange(y, 0, this.width-1);
                break;

            case 'toStart':
                this.ev_eraseInLine('toStart');
                for (var y = this.cursor.y-1; y >= 0; y--) {
                    for (var x = 0; x < this.width; x++)
                        this.putChar('set', x, y, ' ', false, false, true, false, 7, 0);
                    this.scr.lineAttr.splice(y, 1, { width: 'normal', height: 'normal' });
                }
                for (var y = this.cursor.y-1; y >= 0; y--)
                    this.postChange(y, 0, this.width-1);
                break;

            case 'whole':
                for (var y = 0; y < this.height; y++) {
                    for (var x = 0; x < this.width; x++)
                        this.putChar('set', x, y, ' ', false, false, true, false, 7, 0);
                    this.scr.lineAttr.splice(y, 1, { width: 'normal', height: 'normal' });
                }
                for (var y = 0; y < this.height; y++)
                    this.postChange(y, 0, this.width-1);
                break;

            default:
                throw "Can't eraseInDisplay with method '" + how + "'";
        }
    },

    ev_goto: function (to) {
        var x,y;
        if ( to == 'home' ) {
            x = y = 0;
        } else {
            x = to[0]-1;
            y = to[1]-1;
        }

        if ( x < 0 ) x = 0;
        if ( x > this.width ) x = this.width;

        if ( this.mode.originMode == 'screen' ) {
            if ( y < 0 ) y = 0;
            if ( y >= this.height ) y = this.height-1;

        } else { // originMode margin
            if ( y < 0 ) y = 0;
            y += this.margins.top;
            if ( y > this.margins.bottom ) y = this.margins.bottom;
        }

        this.cursor.x = x;
        this.cursor.y = y;

        this.postCursor();
    },

    ev_report: function (type) {
        switch (type) {
            case 'status':
            case 'printer':
            case 'cursorPosition':
            case 'deviceAttributes':
            case 'versionString':
                // TODO
                break;

            default:
                throw "Can't handle report type "+type;
        }
    },

    ev_charset: function (action, which, target) {
        if ( action == 'switch' ) {
            this.charsets.active = which;
        } else if ( action == 'set' ) {
            this.charsets[which] = target;
        } else {
            throw "Can't handle charset action " + action;
        }
    },

    putChar: function (how, x, y, text, bold, underline, lowintensity, blink, fcolor, bcolor) {
        var idx = x + y * this.width;

        if ( how == 'set' ) {
            this.scr.c.text.splice(idx, 1, text);
            this.scr.c.bold.splice(idx, 1, bold);
            this.scr.c.underline.splice(idx, 1, underline);
            this.scr.c.lowintensity.splice(idx, 1, lowintensity);
            this.scr.c.blink.splice(idx, 1, blink);
            this.scr.c.fcolor.splice(idx, 1, fcolor);
            this.scr.c.bcolor.splice(idx, 1, bcolor);
        } else {
            throw "Can't putChar with method " + how;
        }
    },

    scroll: function (lines) {
        var rmidxline, insidxline;

        if ( lines > 0 ) {
            rmidxline = this.margins.top;
            insidxline = this.margins.bottom;
        } else if ( lines < 0 ) {
            rmidxline = this.margins.bottom;
            insidxline = this.margins.top;
        } else {
            return; // lines == 0 or NaN
        }

        var rmidx = this.width * rmidxline;
        var insidx = this.width * insidxline;

        for (var i = 0; i < Math.abs(lines); i++) {
            var obj = {};
            obj.text         = this.scr.c.text.splice(rmidx, this.width).join('');
            obj.bold         = this.scr.c.bold.splice(rmidx, this.width).map(boolToChar).join('');
            obj.underline    = this.scr.c.underline.splice(rmidx, this.width).map(boolToChar).join('');
            obj.lowintensity = this.scr.c.lowintensity.splice(rmidx, this.width).map(boolToChar).join('');
            obj.blink        = this.scr.c.blink.splice(rmidx, this.width).map(boolToChar).join('');
            obj.fcolor       = this.scr.c.fcolor.splice(rmidx, this.width).join('');
            obj.bcolor       = this.scr.c.bcolor.splice(rmidx, this.width).join('');
            obj.lineAttr     = this.scr.lineAttr.splice(rmidxline, 1);
            this.postSpecial({ 'scrollLine': obj, direction: lines/Math.abs(lines) });

            for (var j = 0; j < this.width; j++) {
                this.scr.c.text.splice(insidx, 0, ' ');
                this.scr.c.bold.splice(insidx, 0, false);
                this.scr.c.underline.splice(insidx, 0, false);
                this.scr.c.lowintensity.splice(insidx, 0, true);
                this.scr.c.blink.splice(insidx, 0, false);
                this.scr.c.fcolor.splice(insidx, 0, 7);
                this.scr.c.bcolor.splice(insidx, 0, 0);
            }
            this.scr.lineAttr.splice(insidxline, 0, { width: 'normal', height: 'normal' });
        }

        for (var y = this.margins.top; y <= this.margins.bottom; y++)
            this.postChange(y, 0, this.width-1);
    },

    handleEventDirect: function () {
        this.handleEvent(Array.prototype.slice.call(arguments));
    },

    handleEvent: function (evt) {
        var fn = this["ev_" + evt[0]];
        if ( !fn ) {
            console.log("Warning: can't handle event type " + evt[0]);
        } else {
            fn.apply(this, evt.slice(1));
        }
    },
};

return emu;
})();

if ( typeof(exports) != 'undefined' )
    exports.VTEmulator = VTEmulator;

// TODO: look into using drawRect for backgrounds, to only need a colorMap for every foreground color
var VTFont = (function(){
    var missingCode = "?".charCodeAt(0);

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

        var x = 0;
        var y = 0;
        var count = 0;
        var charsPerRow = 0;
        var last_cp = 0;
        stats.split("\n").forEach(function(v){
                if ( v.length ) {
                    var res;
                    if ( /^\d+$/.exec(v) ) {
                        chars[v] = [x++, y];
                        last_cp = parseInt(v, 10);
                        count++;
                    } else if ( /^y$/.exec(v) ) {
                        if ( x > charsPerRow )
                            charsPerRow = x;
                        x = 0;
                        y++;
                    } else if ( res = /^r(\d+)$/.exec(v) ) {
                        var ct = parseInt(res[1], 10);
                        for (var v2 = last_cp+1; v2 <= last_cp+ct; v2++) {
                            chars[v2] = [x++, y];
                        }
                        count   += ct;
                        last_cp += ct;
                    } else {
                        throw "Stats file is corrupt, line=\""+v+"\"";
                    }
                }
            });

        if ( x > charsPerRow )
            charsPerRow = x;

        this.charCount = count;

        this.charHeight = this.image.naturalHeight / (y+1);
        this.charWidth = this.image.naturalWidth / charsPerRow;
        if ( this.charWidth != Math.floor(this.charWidth) )
            throw "font loading of \""+name+"\" failed: image width is not a multiple of the character count (image width = " + this.image.naturalWidth + ", character count = " + this.charCount + ")";
    };

    Font.prototype = {
        drawChar: function (ctx, ch, x, y, fg, bg) {
            var codepoint = ch.charCodeAt(0);

            var idx;
            if ( typeof(this.chars[codepoint]) != 'undefined' ) {
                idx = this.chars[codepoint];
            }

            if ( typeof idx == 'undefined' ) {
                if ( typeof(this.chars[missingCode]) != 'undefined' ) {
                    idx = this.chars[missingCode];
                } else {
                    throw "Can't draw \""+ch+"\", it is not mapped and neither is the missing character";
                }
            }

            ctx.drawImage(this.getFontColorMap(fg, bg, idx[1]), idx[0]*this.charWidth, 0, this.charWidth, this.charHeight, x, y, this.charWidth, this.charHeight);
        },

        ////////////////////////////////////////////////////////////////////////////////
        // Private

        getFontColorMap: function (fg, bg, chunk) {
            var mapstr = fg + "/" + bg + "/" + chunk;
            if ( this.colorMaps[mapstr] )
                return this.colorMaps[mapstr];

            var w = this.image.naturalWidth;
            var h = this.charHeight;

            var yoff = chunk * this.charHeight;

            var cv = document.createElement('canvas');
            cv.setAttribute('width',  w);
            cv.setAttribute('height', h);

            var ctx = cv.getContext('2d');
            ctx.drawImage(this.image, 0, yoff, w, h, 0, 0, w, h);

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

// todo:
// vt102 printing (vt102 user guide, chapter 5, "printing")
var VTParser = (function(){
    var warnDefault = function (msg) {
        console.log(msg);
    };

    return function (term_cb, warn) {
        if ( !warn ) warn = warnDefault;

        this.cb = term_cb;
        this.warn = warn;
        this.buffer = '';
    };
})();

VTParser.prototype = {
    parse: function (str) {
        this.buffer += str;
        while ( this.handleBuffer() ) ;
        if ( this.buffer.length > 1024 )
            throw "Appear to be stuck at: " + JSON.stringify(this.buffer.toString());
    },

    freeze: function () {
        return { buffer: this.buffer };
    },

    thaw: function (obj) {
        this.buffer = obj.buffer;
    },

    handleBuffer: function () {
        var fn;
        var match;
        var re;

        var me = this;

        this.handlables.forEach(function (s) {
                var m = s[0].exec(me.buffer);
                if ( m && m[0].length > 0 ) {
                    if ( !match || m[0].length < match[0].length ) {
                        match = m;
                        fn = s[1];
                        re = s[0];
                    }
                }
            });

        if ( !match ) return false;

        //console.log("matched /" + re.source + "/" + " for nibbling of " + JSON.stringify(match[0]));

        var nibble_len = match[0].length;
        fn.call(this, match);
        this.buffer = this.buffer.substr(nibble_len);

        return true;
    },

    handlables: [
        ////////////////////////////////////////////////////////////////////////////////
        // control characters
        [/^\007/, function (m) {
            this.cb('specialChar', 'bell');
        }],
        [/^\010/, function (m) {
            this.cb('specialChar', 'backspace');
        }],
        [/^\011/, function (m) {
            this.cb('specialChar', 'horizontalTab');
        }],
        [/^\012/, function (m) {
            this.cb('specialChar', 'lineFeed');
        }],
        [/^\013/, function (m) {
            this.cb('specialChar', 'verticalTab');
        }],
        [/^\014/, function (m) {
            this.cb('specialChar', 'formFeed');
        }],
        [/^\015/, function (m) {
            this.cb('specialChar', 'carriageReturn');
        }],
        [/^\016/, function (m) {
            this.cb('charset', 'switch', 'g1');
        }],
        [/^\017/, function (m) {
            this.cb('charset', 'switch', 'g0');
        }],

        ////////////////////////////////////////////////////////////////////////////////
        // normal characters

        // ascii
        [/^[^\033\007\010\011\012\013\014\015\016\017\x80-\xFF]+/, function (m) {
            if ( /[\x80-\xFF]/.exec(m) )
                console.log("low byte regex matched high bytes");
            this.cb('normalString', m[0]);
        }],

        // utf-8
        [/^[\xC2\xDF][\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-192;
            var p2 = m[0].charCodeAt(1)-128;
            var code = p1*64 + p2;
            //console.log("utf-8 2 byte sequence for " + code);
            this.cb('normalString', String.fromCharCode(code));
        }],
        [/^(\xE0[\xA0-\xBF]|[\xE1-\xEC][\x80-\xBF]|\xED[\x80-\x9F]|[\xEE-\xEF][\x80-\xBF])[\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-224;
            var p2 = m[0].charCodeAt(1)-128;
            var p3 = m[0].charCodeAt(2)-128;
            var code = (p1*64 + p2)*64 + p3;
            //console.log("utf-8 3 byte sequence for " + code);
            this.cb('normalString', String.fromCharCode(code));
        }],
        [/^(\xF0[\x90-\xBF]|[\xF1-\xF3][\x80-\xBF]|\xF4[\x80-\x8F])[\x80-\xBF][\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-240;
            var p2 = m[0].charCodeAt(1)-128;
            var p3 = m[0].charCodeAt(2)-128;
            var p4 = m[0].charCodeAt(3)-128;
            var code = ((p1*64 + p2)*64 + p3)*64 + p4
            //console.log("utf-8 4 byte sequence for " + code);
            this.cb('normalString', String.fromCharCode(code)); // TODO: verify that fromCharCode can handle this
        }],

        // TODO: eat malformed utf-8

        ////////////////////////////////////////////////////////////////////////////////
        // control sequences

        // arrow keys
        [/^\033\[([0-9]*)A/, function (m) {
            this.cb('arrow', 'up', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)B/, function (m) {
            this.cb('arrow', 'down', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)C/, function (m) {
            this.cb('arrow', 'right', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)D/, function (m) {
            this.cb('arrow', 'left', parseInt(m[1] || '1', 10));
        }],

        // cursor set position
        [/^\033\[([0-9]*);([0-9]*)[Hf]/, function (m) {
            this.cb('goto', [parseInt(m[2] || '1', 10), parseInt(m[1] || '1', 10)]);
        }],
        [/^\033\[[Hf]/, function (m) {
            this.cb('goto', 'home');
        }],

        // index and friends
        [/^\033D/, function (m) {
            this.cb('index', 'down');
        }],
        [/^\033M/, function (m) {
            this.cb('index', 'up');
        }],
        [/^\033E/, function (m) {
            this.cb('index', 'nextLine');
        }],

        // cursor save/restore
        [/^\033[7]/, function (m) {
            this.cb('cursorStack', 'push');
        }],
        [/^\033[8]/, function (m) {
            this.cb('cursorStack', 'pop');
        }],

        // keypad
        [/^\033=/, function (m) {
            this.cb('mode', 'keypad', 'cursor');
        }],
        [/^\033>/, function (m) {
            this.cb('mode', 'keypad', 'numeric');
        }],

        // character set selection
        [/^\033\(A/, function (m) {
            this.cb('charset', 'set', 'g0', 'uk');
        }],
        [/^\033\(B/, function (m) {
            this.cb('charset', 'set', 'g0', 'us');
        }],
        [/^\033\(0/, function (m) {
            this.cb('charset', 'set', 'g0', 'line');
        }],
        [/^\033\(1/, function (m) {
            this.cb('charset', 'set', 'g0', 'rom');
        }],
        [/^\033\(2/, function (m) {
            this.cb('charset', 'set', 'g0', 'romSpecial');
        }],
        [/^\033\)A/, function (m) {
            this.cb('charset', 'set', 'g1', 'uk');
        }],
        [/^\033\)B/, function (m) {
            this.cb('charset', 'set', 'g1', 'us');
        }],
        [/^\033\)0/, function (m) {
            this.cb('charset', 'set', 'g1', 'line');
        }],
        [/^\033\)1/, function (m) {
            this.cb('charset', 'set', 'g1', 'rom');
        }],
        [/^\033\)2/, function (m) {
            this.cb('charset', 'set', 'g1', 'romSpecial');
        }],

        // temporary character set
        [/^\033N(a|[^a])/, function (m) {
            this.cb('g2char', m[1]);
        }],
        [/^\033O(a|[^a])/, function (m) {
            this.cb('g3char', m[1]);
        }],

        // mode set/reset
        [/^\033\[(\??)([^\033]*?)h/, function (m) {
            var me = this;
            m[2].split(';').forEach(function (sub) {
                    me.setMode(m[1] + sub);
                });
        }],
        [/^\033\[(\??)([^\033]*?)l/, function (m) {
            var me = this;
            m[2].split(';').forEach(function (sub) {
                    me.resetMode(m[1] + sub);
                });
        }],

        // horizontal tab stops
        [/^\033H/, function (m) {
            this.cb('tabStop', 'add');
        }],
        [/^\033\[0?g/, function (m) {
            this.cb('tabStop', 'remove');
        }],
        [/^\033\[3g/, function (m) {
            this.cb('tabStop', 'clear');
        }],

        // line attributes
        [/^\033#3/, function (m) {
            this.cb('lineAttr', 'dwdhTopHalf');
        }],
        [/^\033#4/, function (m) {
            this.cb('lineAttr', 'dwdhBottomHalf');
        }],
        [/^\033#5/, function (m) {
            this.cb('lineAttr', 'swsh');
        }],
        [/^\033#6/, function (m) {
            this.cb('lineAttr', 'dwsh');
        }],

        // erase in line
        [/^\033\[0?K/, function (m) {
            this.cb('eraseInLine', 'toEnd');
        }],
        [/^\033\[1K/, function (m) {
            this.cb('eraseInLine', 'toStart');
        }],
        [/^\033\[2K/, function (m) {
            this.cb('eraseInLine', 'whole');
        }],

        // erase in display
        [/^\033\[0?J/, function (m) {
            this.cb('eraseInDisplay', 'toEnd');
        }],
        [/^\033\[1J/, function (m) {
            this.cb('eraseInDisplay', 'toStart');
        }],
        [/^\033\[2J/, function (m) {
            this.cb('eraseInDisplay', 'whole');
        }],

        // insertion and deletion
        [/^\033\[([0-9]*)P/, function (m) {
            this.cb('deleteChars', parseInt(m[1].length ? m[1] : '1', 10));
        }],
        [/^\033\[([0-9]*)L/, function (m) {
            this.cb('insertLines', parseInt(m[1].length ? m[1] : '1', 10));
        }],
        [/^\033\[([0-9]*)M/, function (m) {
            this.cb('deleteLines', parseInt(m[1].length ? m[1] : '1', 10));
        }],

        // reports
        [/^\033([0-9;?]*)n/, function (m) {
            var me = this;
            m[1].split(';').forEach(function (r) {
                    me.handleReportRequest(r);
                });
        }],
        [/^\033(\[0?c|Z)/, function (m) {
            this.cb('report', 'deviceAttributes');
        }],
        [/^\033\[>c/, function (m) {
            this.cb('report', 'versionString');
        }],

        // LEDs
        [/^\033\[([0-9;]*)q/, function (m) {
            var me = this;
            (m[1].length ? m[1] : '0').split(';').forEach(function (l) {
                    me.handleLED(l);
                });
        }],

        // xterm-style titles
        [/^\033\]2;([^\033\007]*)\007/, function (m) {
            this.cb('setWindowTitle', m[1]);
        }],
        [/^\033\]1;([^\033\007]*)\007/, function (m) {
            this.cb('setIconTitle', m[1]);
        }],
        [/^\033\]0;([^\033\007]*)\007/, function (m) {
            this.cb('setWindowIconTitle', m[1]);
        }],

        // margins
        [/^\033\[([0-9]+);([0-9]+)r/, function (m) {
            this.cb('setMargins', parseInt(m[1], 10), parseInt(m[2], 10));
        }],
        [/^\033\[r/, function (m) {
            this.cb('resetMargins');
        }],

        // reset
        [/^\033\[!p/, function (m) {
            this.cb('softReset');
        }],
        [/^\033c/, function (m) {
            this.cb('reset');
        }],

        // one-off sequences
        [/^\033\[([0-9;]*)m/, function (m) {
            var me = this;
            (m[1].length ? m[1] : "0").split(';').forEach(function (attr) {
                    me.cb('setAttribute', parseInt(attr, 10));
                });
        }],
        [/^\033\[([0-9;]*)y/, function (m) {
            this.cb('hardware', 'selfTestRaw', m[1]);
        }],
        [/^\033#8/, function (m) {
            this.cb('hardware', 'screenAlignment');
        }],
    ],

    setMode: function (mode) {
        switch (mode) {
            case '?1':
                this.cb('mode', 'cursorKeyANSI', false);
                break;

            case '?3':
                this.cb('mode', 'width', 132);
                break;

            case '?4':
                this.cb('mode', 'scroll', 'smooth');
                break;

            case '?5':
                this.cb('mode', 'reverseScreen', true);
                break;

            case '?6':
                this.cb('originMode', 'margin');
                break;

            case '?7':
                this.cb('mode', 'autoWrap', true);
                break;

            case '?8':
                this.cb('mode', 'autoRepeat', true);
                break;

            case '?9':
                this.cb('mode', 'mouseTrackingDown', true);
                break;

            case '?47':
                this.cb('mode', 'currentScreen', 0);
                break;

            case '?1000':
                this.cb('mode', 'mouseTrackingUp', true);
                break;

            case '2':
                this.cb('mode', 'keyboardLocked', true);
                break;

            case '4':
                this.cb('mode', 'insert', true);
                break;

            case '12':
                this.cb('mode', 'localEcho', false);
                break;

            case '20':
                this.cb('mode', 'newLineMode', 'crlf');
                break;

            default:
                this.warn('Unhandled set mode: "' + mode + '"');
        }
    },

    resetMode: function (mode) {
        switch (mode) {
            case '?1':
                this.cb('mode', 'cursorKeyANSI', true);
                break;

            case '?2':
                this.cb('mode', 'vt52', true);
                break;

            case '?3':
                this.cb('mode', 'width', 80);
                break;

            case '?4':
                this.cb('mode', 'scroll', 'jump');
                break;

            case '?5':
                this.cb('mode', 'reverseScreen', false);
                break;

            case '?6':
                this.cb('originMode', 'screen');
                break;

            case '?7':
                this.cb('mode', 'autoWrap', false);
                break;

            case '?8':
                this.cb('mode', 'autoRepeat', false);
                break;

            case '?9':
                this.cb('mode', 'mouseTrackingDown', false);
                break;

            case '?47':
                this.cb('mode', 'currentScreen', 1);
                break;

            case '?1000':
                this.cb('mode', 'mouseTrackingUp', false);
                break;

            case '2':
                this.cb('mode', 'keyboardLocked', false);
                break;

            case '4':
                this.cb('mode', 'insert', false);
                break;

            case '12':
                this.cb('mode', 'localEcho', true);
                break;

            case '20':
                this.cb('mode', 'newLineMode', 'cr');
                break;

            default:
                this.warn('Unhandled reset mode: "' + mode + '"');
        }
    },

    handleReportRequest: function (req) {
        switch (req) {
            case '5':
                this.cb('report', 'status');
                break;

            case '?15':
                this.cb('report', 'printer');
                break;

            case '6':
                this.cb('report', 'cursorPosition');
                break;

            default:
                this.warn('Unhandled report request: "' + req + '"');
        }
    },

    handleLED: function (led) {
        led = parseInt(led, 10);
        if ( led == 0 ) {
            this.cb('led', 'off', 'all');
        } else {
            this.cb('led', 'on', led);
        }
    },
};

if ( typeof(exports) != 'undefined' )
    exports.VTParser = VTParser;

function get_binary_data_sync(url) {
    var r = new XMLHttpRequest();
    r.open("GET", url, false);
    r.overrideMimeType("text/plain; charset=x-user-defined"); // thx Marcus Granado, 2006 @ mgran.blogspot.com
    r.send(null);

    if ( r.status != 200 ) {
        alert("couldn't fetch binary data from " + url + ", code " + r.status);
        return '';
    }

    return r.responseText;
}

function get_binary_data_async(url, cb) {
    var r = new XMLHttpRequest();
    r.open("GET", url, true);
    r.overrideMimeType("text/plain; charset=x-user-defined"); // thx Marcus Granado, 2006 @ mgran.blogspot.com
    r.onreadystatechange = function () {
            if ( r.readyState == 4 ) {
                if ( r.status != 200 ) {
                    cb(null, r.statusText);
                } else {
                    cb(r.responseText, null);
                }
            }
        };
    r.send(null);
}

function r_uint8(data, offset) {
    return data.charCodeAt(offset) & 0xff;
}

function r_uint16be(data, offset) {
    var h = data.charCodeAt(offset  ) & 0xff;
    var l = data.charCodeAt(offset+1) & 0xff;
    return h*256 + l;
}

function r_uint16le(data, offset) {
    var h = data.charCodeAt(offset+1) & 0xff;
    var l = data.charCodeAt(offset  ) & 0xff;
    return h*256 + l;
}

function r_uint32be(data, offset) {
    var hh = data.charCodeAt(offset  ) & 0xff;
    var hl = data.charCodeAt(offset+1) & 0xff;
    var lh = data.charCodeAt(offset+2) & 0xff;
    var ll = data.charCodeAt(offset+3) & 0xff;
    return (hh*256 + hl) * 65536 + (lh*256 + ll);
}

function r_uint32le(data, offset) {
    var hh = data.charCodeAt(offset+3) & 0xff;
    var hl = data.charCodeAt(offset+2) & 0xff;
    var lh = data.charCodeAt(offset+1) & 0xff;
    var ll = data.charCodeAt(offset  ) & 0xff;
    return (hh*256 + hl) * 65536 + (lh*256 + ll);
}

function r_uint64be(data, offset) {
    return r_uint32be(data, offset)*65536*65536 + r_uint32be(data, offset+4);
}

function r_uint64le(data, offset) {
    return r_uint32le(data, offset+4)*65536*65536 + r_uint32le(data, offset);
}

function DummyTerminal(canvas_element, dump_url, opts){
    function get_now(){ return (new Date()).getTime() / 1000; }
    var self = this;
    self.startIfReady = function(){
      if (self.state.viewReady && self.state.playReady) self.go();
    }
    self.go = function(){
      self.state.time_diff = get_now() - self.state.tty_data[self.state.nextFrameIdx].time;
      self.advanceFrame();
    }
    self.advanceFrame = function(){
      var framesCounted = 0;
      while ( framesCounted < self.state.frameJumpMax && self.state.nextFrameIdx < self.state.tty_data.length && self.state.tty_data[self.state.nextFrameIdx].time + self.state.time_diff - get_now() < 0 ) {
        record = self.state.tty_data[self.state.nextFrameIdx++];
        self.vtview.parseData(record.data);
        framesCounted++;
      }

      self.vtview.draw();

      if (self.state.nextFrameIdx < self.state.tty_data.length){
        self.state.nextFrameTimeout = setTimeout(self.advanceFrame, self.state.tty_data[0].time + self.state.time_diff - get_now() * 1000 + self.state.accurateTimeInterval);
      }

    }

    self.opts = opts || {};

    self.state = {
        dump_url: dump_url,
        nextFrameIdx: 0,
        tty_data: null,
        frameJumpMax: 20,
        time_diff: 0,
        accurateTimeInterval: 1000/60,
        viewReady: false,
        playReady: false,
        playing: false,
        initialState: null
    }

    self.run = function(){
        self.vtview = new VTCanvasView(canvas_element, {
            onReady: function(){
                self.state.viewReady = true;
                self.startIfReady()
            },
            fontName: self.opts.font_name || 'fixed-9x18'
        });
        self.state.initialState = { vtview: self.vtview.freeze(), nextFrameIdx: 0 };
    }
    self.get_data = function(url){
        get_binary_data_async(url, function(data,err){
            if (err) throw err;
            self.state.tty_data = TTYRecParse(data);
            self.state.playReady = true;
            self.startIfReady();
        })
    }
    if (self.state.dump_url){
        self.get_data(self.state.dump_url);
    }

    self.player_interface = {
        play_toggle: function(){
            if (self.state.nextFrameTimeout){
              clearTimeout(self.state.nextFrameTimeout);
              self.state.nextFrameTimeout = null;
            } else {
              self.go();
            }
        }
    }
}
function fixHighCharCodes(data) {
    var ch = [];
    for (var i = 0; i < data.length; i++)
        ch.push( String.fromCharCode( data.charCodeAt(i) & 0xff ) );
    return ch.join('');
}

// contents is a string
TTYRecParse = function (contents) {
    var out = [];

    var pos = 0;
    while ( pos < contents.length ) {
        var  sec = r_uint32le(contents, pos); pos += 4;
        var usec = r_uint32le(contents, pos); pos += 4;
        var  len = r_uint32le(contents, pos); pos += 4;

        var data = contents.substr(pos, len); pos += len;
        for (var i = 0; i < len; i++)
            if ( data.charCodeAt(i) > 255 ) {
                data = fixHighCharCodes(data);
                break;
            }

        out.push({ time: sec + usec/1000000, data: data });
    }

    return out;
};

