var VTParser = (function(){

var warnDefault = function (msg) {
    console.log(msg);
}

return function (term_cb, warn) {
    if ( !warn ) warn = warnDefault;

    // todo:
    // vt102 printing (vt102 user guide, chapter 5, "printing")

    var setMode = function (mode) {
        switch (mode) {
            case '?1':
                term_cb('mode', 'cursorKeyANSI', false);
                break;

            case '?3':
                term_cb('mode', 'width', 132);
                break;

            case '?4':
                term_cb('mode', 'scroll', 'smooth');
                break;

            case '?5':
                term_cb('mode', 'reverseScreen', true);
                break;

            case '?6':
                term_cb('originMode', 'margin');
                break;

            case '?7':
                term_cb('mode', 'autoWrap', true);
                break;

            case '?8':
                term_cb('mode', 'autoRepeat', true);
                break;

            case '?9':
                term_cb('mode', 'mouseTrackingDown', true);
                break;

            case '?47':
                term_cb('mode', 'currentScreen', 0);
                break;

            case '?1000':
                term_cb('mode', 'mouseTrackingUp', true);
                break;

            case '2':
                term_cb('mode', 'keyboardLocked', true);
                break;

            case '4':
                term_cb('mode', 'insert', true);
                break;

            case '12':
                term_cb('mode', 'localEcho', false);
                break;

            case '20':
                term_cb('mode', 'newLineMode', 'crlf');
                break;

            default:
                warn('Unhandled set mode: "' + mode + '"');
        }
    };

    var resetMode = function (mode) {
        switch (mode) {
            case '?1':
                term_cb('mode', 'cursorKeyANSI', true);
                break;

            case '?2':
                term_cb('mode', 'vt52', true);
                break;

            case '?3':
                term_cb('mode', 'width', 80);
                break;

            case '?4':
                term_cb('mode', 'scroll', 'jump');
                break;

            case '?5':
                term_cb('mode', 'reverseScreen', false);
                break;

            case '?6':
                term_cb('originMode', 'screen');
                break;

            case '?7':
                term_cb('mode', 'autoWrap', false);
                break;

            case '?8':
                term_cb('mode', 'autoRepeat', false);
                break;

            case '?9':
                term_cb('mode', 'mouseTrackingDown', false);
                break;

            case '?47':
                term_cb('mode', 'currentScreen', 1);
                break;

            case '?1000':
                term_cb('mode', 'mouseTrackingUp', false);
                break;

            case '2':
                term_cb('mode', 'keyboardLocked', false);
                break;

            case '4':
                term_cb('mode', 'insert', false);
                break;

            case '12':
                term_cb('mode', 'localEcho', true);
                break;

            case '20':
                term_cb('mode', 'newLineMode', 'cr');
                break;

            default:
                warn('Unhandled reset mode: "' + mode + '"');
        }
    };

    var handleReportRequest = function (req) {
        switch (req) {
            case '5':
                term_cb('report', 'status');
                break;

            case '?15':
                term_cb('report', 'printer');
                break;

            case '6':
                term_cb('report', 'cursorPosition');
                break;

            default:
                warn('Unhandled report request: "' + req + '"');
        }
    };

    var handleLED = function (led) {
        led = parseInt(led, 10);
        if ( led == 0 ) {
            term_cb('led', 'off', 'all');
        } else {
            term_cb('led', 'on', led);
        }
    };

    var handlables = [
        ////////////////////////////////////////////////////////////////////////////////
        // control characters
        [/^\007/, function (m) {
            term_cb('specialChar', 'bell');
        }],
        [/^\010/, function (m) {
            term_cb('specialChar', 'backspace');
        }],
        [/^\011/, function (m) {
            term_cb('specialChar', 'horizontalTab');
        }],
        [/^\012/, function (m) {
            term_cb('specialChar', 'lineFeed');
        }],
        [/^\013/, function (m) {
            term_cb('specialChar', 'verticalTab');
        }],
        [/^\014/, function (m) {
            term_cb('specialChar', 'formFeed');
        }],
        [/^\015/, function (m) {
            term_cb('specialChar', 'carriageReturn');
        }],
        [/^\016/, function (m) {
            term_cb('charset', 'switch', 'g1');
        }],
        [/^\017/, function (m) {
            term_cb('charset', 'switch', 'g0');
        }],

        ////////////////////////////////////////////////////////////////////////////////
        // normal characters

        // ascii
        [/^[^\033\007\010\011\012\013\014\015\016\017\x80-\xFF]+/, function (m) {
            if ( /[\x80-\xFF]/.exec(m) ) {
                console.log("low byte regex matched high bytes");
            }
            term_cb('normalString', m[0]);
        }],

        // utf-8
        [/^[\xC2\xDF][\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-192;
            var p2 = m[0].charCodeAt(1)-128;
            var code = p1*64 + p2;
            console.log("utf-8 2 byte sequence for " + code);
            term_cb('normalString', String.fromCharCode(code));
        }],
        [/^(\xE0[\xA0-\xBF]|[\xE1-\xEC][\x80-\xBF]|\xED[\x80-\x9F]|[\xEE-\xEF][\x80-\xBF])[\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-224;
            var p2 = m[0].charCodeAt(1)-128;
            var p3 = m[0].charCodeAt(2)-128;
            var code = (p1*64 + p2)*64 + p3;
            console.log("utf-8 3 byte sequence for " + code);
            term_cb('normalString', String.fromCharCode(code));
        }],
        [/^(\xF0[\x90-\xBF]|[\xF1-\xF3][\x80-\xBF]|\xF4[\x80-\x8F])[\x80-\xBF][\x80-\xBF]/, function (m) {
            var p1 = m[0].charCodeAt(0)-240;
            var p2 = m[0].charCodeAt(1)-128;
            var p3 = m[0].charCodeAt(2)-128;
            var p4 = m[0].charCodeAt(3)-128;
            var code = ((p1*64 + p2)*64 + p3)*64 + p4
            console.log("utf-8 4 byte sequence for " + code);
            term_cb('normalString', String.fromCharCode(code)); // TODO: verify that fromCharCode can handle this
        }],

        // TODO: eat malformed utf-8

        ////////////////////////////////////////////////////////////////////////////////
        // control sequences

        // arrow keys
        [/^\033\[([0-9]*)A/, function (m) {
            term_cb('arrow', 'up', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)B/, function (m) {
            term_cb('arrow', 'down', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)C/, function (m) {
            term_cb('arrow', 'right', parseInt(m[1] || '1', 10));
        }],
        [/^\033\[([0-9]*)D/, function (m) {
            term_cb('arrow', 'left', parseInt(m[1] || '1', 10));
        }],

        // cursor set position
        [/^\033\[([0-9]*);([0-9]*)[Hf]/, function (m) {
            term_cb('goto', [parseInt(m[2] || '1', 10), parseInt(m[1] || '1', 10)]);
        }],
        [/^\033\[[Hf]/, function (m) {
            term_cb('goto', 'home');
        }],

        // index and friends
        [/^\033D/, function (m) {
            term_cb('index', 'down');
        }],
        [/^\033M/, function (m) {
            term_cb('index', 'up');
        }],
        [/^\033E/, function (m) {
            term_cb('index', 'nextLine');
        }],

        // cursor save/restore
        [/^\033[7]/, function (m) {
            term_cb('cursorStack', 'push');
        }],
        [/^\033[8]/, function (m) {
            term_cb('cursorStack', 'pop');
        }],

        // keypad
        [/^\033=/, function (m) {
            term_cb('mode', 'keypad', 'cursor');
        }],
        [/^\033>/, function (m) {
            term_cb('mode', 'keypad', 'numeric');
        }],

        // character set selection
        [/^\033\(A/, function (m) {
            term_cb('charset', 'set', 'g0', 'uk');
        }],
        [/^\033\(B/, function (m) {
            term_cb('charset', 'set', 'g0', 'us');
        }],
        [/^\033\(0/, function (m) {
            term_cb('charset', 'set', 'g0', 'line');
        }],
        [/^\033\(1/, function (m) {
            term_cb('charset', 'set', 'g0', 'rom');
        }],
        [/^\033\(2/, function (m) {
            term_cb('charset', 'set', 'g0', 'romSpecial');
        }],
        [/^\033\)A/, function (m) {
            term_cb('charset', 'set', 'g1', 'uk');
        }],
        [/^\033\)B/, function (m) {
            term_cb('charset', 'set', 'g1', 'us');
        }],
        [/^\033\)0/, function (m) {
            term_cb('charset', 'set', 'g1', 'line');
        }],
        [/^\033\)1/, function (m) {
            term_cb('charset', 'set', 'g1', 'rom');
        }],
        [/^\033\)2/, function (m) {
            term_cb('charset', 'set', 'g1', 'romSpecial');
        }],

        // temporary character set
        [/^\033N(a|[^a])/, function (m) {
            term_cb('g2char', m[1]);
        }],
        [/^\033O(a|[^a])/, function (m) {
            term_cb('g3char', m[1]);
        }],

        // mode set/reset
        [/^\033\[(\??)([^\033]*?)h/, function (m) {
            m[2].split(';').forEach(function (sub) {
                    setMode(m[1] + sub);
                });
        }],
        [/^\033\[(\??)([^\033]*?)l/, function (m) {
            m[2].split(';').forEach(function (sub) {
                    resetMode(m[1] + sub);
                });
        }],

        // horizontal tab stops
        [/^\033H/, function (m) {
            term_cb('tabStop', 'add');
        }],
        [/^\033\[0?g/, function (m) {
            term_cb('tabStop', 'remove');
        }],
        [/^\033\[3g/, function (m) {
            term_cb('tabStop', 'clear');
        }],

        // line attributes
        [/^\033#3/, function (m) {
            term_cb('lineAttr', 'dwdhTopHalf');
        }],
        [/^\033#4/, function (m) {
            term_cb('lineAttr', 'dwdhBottomHalf');
        }],
        [/^\033#5/, function (m) {
            term_cb('lineAttr', 'swsh');
        }],
        [/^\033#6/, function (m) {
            term_cb('lineAttr', 'dwsh');
        }],

        // erase in line
        [/^\033\[0?K/, function (m) {
            term_cb('eraseInLine', 'toEnd');
        }],
        [/^\033\[1K/, function (m) {
            term_cb('eraseInLine', 'toStart');
        }],
        [/^\033\[2K/, function (m) {
            term_cb('eraseInLine', 'whole');
        }],

        // erase in display
        [/^\033\[0?J/, function (m) {
            term_cb('eraseInDisplay', 'toEnd');
        }],
        [/^\033\[1J/, function (m) {
            term_cb('eraseInDisplay', 'toStart');
        }],
        [/^\033\[2J/, function (m) {
            term_cb('eraseInDisplay', 'whole');
        }],

        // insertion and deletion
        [/^\033\[([0-9]*)P/, function (m) {
            term_cb('deleteChars', parseInt(m[1].length ? m[1] : '1', 10));
        }],
        [/^\033\[([0-9]*)L/, function (m) {
            term_cb('insertLines', parseInt(m[1].length ? m[1] : '1', 10));
        }],
        [/^\033\[([0-9]*)M/, function (m) {
            term_cb('deleteLines', parseInt(m[1].length ? m[1] : '1', 10));
        }],

        // reports
        [/^\033([0-9;?]*)n/, function (m) {
            m[1].split(';').forEach(handleReportRequest);
        }],
        [/^\033(\[0?c|Z)/, function (m) {
            term_cb('report', 'deviceAttributes');
        }],
        [/^\033\[>c/, function (m) {
            term_cb('report', 'versionString');
        }],

        // LEDs
        [/^\033\[([0-9;]*)q/, function (m) {
            (m[1].length ? m[1] : '0').split(';').forEach(handleLED);
        }],

        // xterm-style titles
        [/^\033\]2;([^\033\007]*)\007/, function (m) {
            term_cb('setWindowTitle', m[1]);
        }],
        [/^\033\]1;([^\033\007]*)\007/, function (m) {
            term_cb('setIconTitle', m[1]);
        }],
        [/^\033\]0;([^\033\007]*)\007/, function (m) {
            term_cb('setWindowIconTitle', m[1]);
        }],

        // margins
        [/^\033\[([0-9]+);([0-9]+)r/, function (m) {
            term_cb('setMargins', parseInt(m[1], 10), parseInt(m[2], 10));
        }],
        [/^\033\[r/, function (m) {
            term_cb('resetMargins');
        }],

        // reset
        [/^\033\[!p/, function (m) {
            term_cb('softReset');
        }],
        [/^\033c/, function (m) {
            term_cb('reset');
        }],

        // one-off sequences
        [/^\033\[([0-9;]*)m/, function (m) {
            (m[1].length ? m[1] : "0").split(';').forEach(function (attr) {
                    term_cb('setAttribute', parseInt(attr, 10));
                });
        }],
        [/^\033\[([0-9;]*)y/, function (m) {
            term_cb('hardware', 'selfTestRaw', m[1]);
        }],
        [/^\033#8/, function (m) {
            term_cb('hardware', 'screenAlignment');
        }],
    ];

    var buffer = '';
    var handleBuffer = function () {
        var fn;
        var match;
        var re;

        handlables.forEach(function (s) {
                var m = s[0].exec(buffer);
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
        fn(match);
        buffer = buffer.substr(nibble_len);

        return true;
    };

    return function (str) {
        buffer += str;
        while ( handleBuffer() ) ;
        if ( buffer.length > 1024 ) {
            throw "Appear to be stuck at: " + JSON.stringify(buffer.toString());
        }
    };
};
})();

if ( typeof(exports) != 'undefined' )
    exports.VTParser = VTParser;

