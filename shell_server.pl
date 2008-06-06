#!/usr/bin/perl
use warnings;
use strict;

my $max_session_idle = 60; # more than a minute without a request

use POE;
use POE::Component::Server::HTTP;

use Term::Emulator;
use TermEncoder;

use URI;
use URI::QueryParam;
use JSON;
use HTTP::Status;
use POSIX ':sys_wait_h';

POE::Component::Server::HTTP->new(
    Port => 8192,
    ContentHandler => { '/api' => \&http, '/' => \&static }
);

POE::Kernel->run;
exit;

sub static {
    my ($req, $res) = @_;
    my $path = $req->uri->path;
    print $req->uri."\n";
    if ( $path eq "/" ) {
        $res->code(RC_OK);
        $res->content(<<EOF);
<html>
<head>
<script src="/streamtty.js"></script>
</head>
<body>
<div id="tty">Enable javascript, asshole</div>
<script>
startStreamTTY( document.getElementById("tty") );
</script>
</body>
</html>
EOF
        return RC_OK;
    } elsif ( $path eq "/streamtty.js" ) {
        open my $lf, "<", "html/streamtty.js" or die $!;
        my $content = do { local $/; <$lf> };
        close $lf;
        $res->code(RC_OK);
        $res->content($content);
        return RC_OK;
    } else {
        $res->code(404);
        $res->content("Not found.");
        return 404;
    }
}

my %sessions = ();

sub reap {
    for my $id ( keys %sessions ) {
        if ( time() - $sessions{$id}{'last_active'} > $max_session_idle ) {
            print "reaped session: $id\n";
            my $s = delete $sessions{$id};
            $s->{'term'}->stop_it_in(1);
        }
    }
    print "reapstart\n";
    1 while waitpid(-1, WNOHANG) > 0;
    print "reapend\n";
}

sub req_error {
    my ($res,$msg) = @_;
    $res->code(500);
    $res->content($msg);
    return RC_OK;
}

sub http {
    my ($req, $res) = @_;
    my $uri = $req->uri;
    print "$uri\n";

    reap();

    if ( $uri->query_param("type") eq "create session" ) {
        my $id = new_session();
        print "new session: $id\n";
        $sessions{$id}->{'term'}->work_for(0.05);
        $res->code(RC_OK);
        $res->content( to_json { ok => 1, id => $id, iframe => $sessions{$id}->{'encoder'}->next_iframe } );
        return RC_OK;

    } elsif ( $uri->query_param("type") eq "user input" ) {
        my $id = $uri->query_param("id");
        return req_error($res, "No such session.") unless exists $sessions{$id};
        $sessions{$id}{'last_active'} = time;
        my ($term, $enc) = @{$sessions{$id}}{'term', 'encoder'};
        $term->userinput($uri->query_param("keys"));
        $term->work_for(0.05);
        $res->code(RC_OK);
        $res->content( to_json { ok => 1, id => $id, pframe => $enc->next_pframe } );
        return RC_OK;

    } elsif ( $uri->query_param("type") eq "pframe" ) {
        my $id = $uri->query_param("id");
        return req_error($res, "No such session.") unless exists $sessions{$id};
        $sessions{$id}{'last_active'} = time;
        my ($term, $enc) = @{$sessions{$id}}{'term', 'encoder'};
        $term->work_for(0.05);
        $res->code(RC_OK);
        $res->content( to_json { ok => 1, id => $id, pframe => $enc->next_pframe } );
        return RC_OK;

    } elsif ( $uri->query_param("type") eq "close session" ) {
        my $id = $uri->query_param("id");
        return req_error($res, "No such session.") unless exists $sessions{$id};
        my $s = delete $sessions{$id};
        my $term = $s->{'term'};
        $term->stop_it_in(1);
        $res->code(RC_OK);
        $res->content( to_json { ok => 1 } );
        return RC_OK;

    } else {
        print "err\n";
        return req_error($res, "Bad request: unknown request type");
    }
}

sub new_session {
    my $id = '';
    while ( not length $id or exists $sessions{$id} ) {
        $id = unpack "H*", join '', map chr rand 255, 1 .. 20;
    }
    my $term = Term::Emulator->new;
    $term->spawn("login");
    my $encoder = TermEncoder->new(term => $term->term);
    $sessions{$id} = {
        term => $term,
        encoder => $encoder,
        last_active => time,
    };
    return $id;
}

