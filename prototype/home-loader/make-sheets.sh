#!/bin/zsh
# Every stage 1 contact sheet, from the recordings folder.
set -u
M=${1:?motion notes folder}
R="$M/recordings"; S="$M/sheets"; mkdir -p "$S"
CS=${0:A:h}/contact-sheet.mjs
T=-2400,-1200,-300,-150,0,100,200,300,450,600,800,1000,1150,1300,2500
node $CS --out "$S/1440-handoff.jpg" --times $T --cell 360 --title "1440x900 at 2x, the handoff, no mouse. R = reveal start (the mask begins to open)." \
 "today (next)=$R/today-next-1440" "(ii) stand-in portrait=$R/proto-ii-standin-1440" "(ii) back+front flattened=$R/proto-ii-composite-1440" "v1.1.0 (lands)=$R/v110-1440"
node $CS --out "$S/1440-handoff-crop.jpg" --times -1200,-150,0,50,100,150,200,300 --cell 400 --crop 480 --title "1440x900 at 2x, the portrait at 1:1 (480 px around the center), no mouse" \
 "today (next)=$R/today-next-1440" "(ii) stand-in portrait=$R/proto-ii-standin-1440" "(ii) back+front flattened=$R/proto-ii-composite-1440" "v1.1.0 (lands)=$R/v110-1440"
node $CS --out "$S/390-handoff.jpg" --times $T --cell 200 --title "390x844 at 2x, touch, the handoff" \
 "today (next)=$R/today-next-390" "(ii) stand-in=$R/proto-ii-standin-390" "(ii) front.png=$R/proto-ii-front-390" "(ii) flattened=$R/proto-ii-composite-390" "v1.1.0=$R/v110-390"
node $CS --out "$S/1440-i-comparison.jpg" --times -1200,0,150,300,800,1300 --cell 360 --title "(i) no tilt beside today and (ii), no mouse; and no portrait at all" \
 "today (next)=$R/today-next-1440" "(i) stand-in=$R/proto-i-standin-1440" "(ii) stand-in=$R/proto-ii-standin-1440" "no portrait=$R/proto-none-1440"
if [ -d "$R/proto-ii-standin-1440-corners" ] && grep -q '"refined"\|"zero": "revealStart"' "$R/proto-ii-standin-1440-corners/timeline.json"; then
  node $CS --out "$S/1440-tilt-corners.jpg" --align portraitFirst --times 350,850,1350,1850,2350 --cell 300 --crop 480 --title "1440 tilt: P = portrait's first paint. Mouse off the card (rest), then top-left, top-right, bottom-right, bottom-left corners of the card" \
   "today (next)=$R/today-next-1440-corners" "v1.1.0 two layers=$R/v110-1440-corners" "(ii) stand-in=$R/proto-ii-standin-1440-corners" "(ii) front.png=$R/proto-ii-front-1440-corners" "(ii) flattened=$R/proto-ii-composite-1440-corners"
  node $CS --out "$S/1440-tilt-handoff.jpg" --times -300,-150,0,50,100,150,200,300 --cell 300 --crop 480 --title "1440 tilt mid-handoff: mouse held on the card's top-right corner from P+2500 (about R-1450)" \
   "today (next)=$R/today-next-1440-corners" "v1.1.0 two layers=$R/v110-1440-corners" "(ii) stand-in=$R/proto-ii-standin-1440-corners" "(ii) front.png=$R/proto-ii-front-1440-corners" "(ii) flattened=$R/proto-ii-composite-1440-corners"
fi
