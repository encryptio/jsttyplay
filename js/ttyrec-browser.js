// contents is a string
TTYRecParse = function (contents) {
    var out = [];

    var pos = 0;
    while ( pos < contents.length ) {
        var  sec = r_uint32le(contents, pos); pos += 4;
        var usec = r_uint32le(contents, pos); pos += 4;
        var  len = r_uint32le(contents, pos); pos += 4;

        var data = contents.substr(pos, len); pos += len;

        out.push({ time: sec + usec/1000000, data: data });
    }

    return out;
};

