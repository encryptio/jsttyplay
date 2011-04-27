#!/usr/bin/perl
use warnings;
use strict;
$| = 1;

my ($input, $outimage, $outstats) = @ARGV;
die "need an input file" unless $input;
die "need an output image file" unless $outimage;
die "need an output stats file" unless $outstats;

die "output image file must have extension .png" unless $outimage =~ /\.png$/;

my $skipped = 0;

my %font_map;
my $font_width;
my $font_height;

sub parse_char {
    my ($char, $line) = @_;
    my @lines = grep { defined and length } split /\n/, $char;

    my $header = shift @lines;

    my $unicode_value;

    if ( $header =~ /^U\+([a-fA-F0-9]{4})$/ ) {
        $unicode_value = unpack "n", pack "H*", $1;
    } elsif ( length $header == 1 ) {
        $unicode_value = ord $header;
    } elsif ( $header =~ /^"(.)"$/ ) {
        $unicode_value = ord $1;
    } elsif ( $header =~ /^'(.)'$/ ) {
        $unicode_value = ord $1;
    } elsif ( $header eq "TODO" or $header eq "SKIP" ) {
        $skipped++;
        return;
    } else {
        die "can't handle a header of \"$header\" (line $line)";
    }

    my $height = @lines;
    my $width = length $lines[0];
    
    length $lines[$_] == $width or die "Non-rectangular character \"$header\" (line $line)"
        for 0 .. $#lines;

    $font_width  = $width  unless defined $font_width;
    $font_height = $height unless defined $font_height;

    die "Character dimensions (${width}x${height}) for \"$header\" do not match font dimensions (${font_width}x${font_height}) (line $line)"
        if $font_width != $width or $font_height != $height;

    tr/[., ]/0/, tr/[1X@MOSW]/1/ for @lines;

    @lines = map [split //, $_], @lines;

    ($_ ne '1' and $_ ne '0') and die "Bad character value '$_' for \"$header\" (line $line)"
        for map @$_, @lines;

    $font_map{$unicode_value} = \@lines;
}

open my $lf, "<", $ARGV[0] or die;
my $char_data = '';
my $char_line_no;
my $line_no = 0;
while ( <$lf> ) {
    chomp;
    s/\s*#.*$//;
    if ( length ) {
        $char_line_no = $line_no unless defined $char_line_no;
        $char_data .= "$_\n";
    } elsif ( length $char_data ) {
        parse_char($char_data, $char_line_no);
        $char_data = '';
        undef $char_line_no;
    }
}
parse_char($char_data) if length $char_data;
close $lf;

print STDERR "Characters: parsed ".scalar(keys %font_map).", skipped $skipped\n";
print STDERR "Font size: ${font_width}x${font_height}\n";

my @codepoints = sort { $a <=> $b } keys %font_map;

print STDERR "Writing image...\n";
open my $sf, "|-", "convert", "pbm:-", "png:$outimage" or die;
print $sf "P4 ".($font_width * @codepoints)." $font_height ";
for my $line ( 0 .. $font_height-1 ) {
    my $bits = '';
    for my $ch ( @codepoints ) {
        $bits .= join '', @{ $font_map{$ch}[$line] };
        if ( length $bits > 512 ) {
            my $kb = substr $bits, 0, 512, '';
            print $sf pack "B*", $kb;
        }
    }
    $bits .= "0" while length($bits) % 8 != 0;
    print $sf pack "B*", $bits;
}
close $sf;

print STDERR "Writing stats...\n";
open $sf, ">", $outstats or die;
for my $cp ( @codepoints ) {
    print $sf "$cp\n";
}
close $sf;

print STDERR "Done.\n";

