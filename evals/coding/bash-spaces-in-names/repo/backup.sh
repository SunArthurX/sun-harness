#!/usr/bin/env bash
src=$1
dst=$2
mkdir -p $dst
count=0
for f in $(ls $src/*.txt); do
  cp $f $dst/
  count=$((count+1))
done
echo $count
