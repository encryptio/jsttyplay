touch jsttyplay-all.js
echo '' > jsttyplay-all.js
cat ../js/vt/*.js >> jsttyplay-all.js
cat ../js/*.js >> jsttyplay-all.js

uglifyjs jsttyplay-all.js > jsttyplay-all-min.js
