#!/usr/bin/perl
use warnings;
use strict;
$| = 1;

use Term::TtyRec;
use TermParser;
use FileHandle;
use Time::HiRes qw/ time sleep /;
use Carp;

$SIG{INT} = sub { confess };

sub openRec {
    my ($fn) = @_;
    my $fh = FileHandle->new($fn, "r") or die;
    my $rec = Term::TtyRec->new($fh);
    return $rec;
}

my $buf = '';
my $lasttime;
sub parseFrame {
    my ($rec, $term) = @_;
    if ( length $buf == 0 ) {
        my ($time, $data) = $rec->read_next;
        return () unless defined $time;
        $buf .= $data;
        $lasttime = $time;
    }
    $term->parse(substr $buf, 0, 1);
    substr($buf, 0, 1) = '';
    return $lasttime;
}

###

my $width = 80;
my $height = 24;
my $term = TermParser->new( width => $width, height => $height );
my $rec  = openRec($ARGV[0]);

system("clear");
while ( defined(my $time = parseFrame($rec, $term)) ) {
    print "\033[H".$term->as_termstring."--";
    sleep 0.25;
}

