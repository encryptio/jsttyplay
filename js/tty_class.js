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
