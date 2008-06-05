#!/usr/bin/perl
use warnings;
use strict;

$| = 1;

use TermParser;
use Term::ReadKey;
use IO::Pty::Easy;
use Time::HiRes qw/ sleep /;

sub key { ReadMode(4); my $key = ReadKey(-1); ReadMode(0); return $key; }
my $term = TermParser->new;
my $pty = IO::Pty::Easy->new;
$pty->spawn("bash");

while ( $pty->is_active ) {
    my $txt = $pty->read(0);
    $term->parse($txt) if $txt;
    print "\033[H" . $term->as_termstring . "\n--\n";
    my $key = key();
    if ( defined $key ) {
        $term->key($key);
        if ( length $term->output ) {
            $pty->write($term->output);
            $term->output = '';
        }
    } else {
        sleep 0.1;
    }
}

print "\nexited\n";

