#!/bin/bash
# Builds the Smelliest Pilgrim phone app (SmelliestPilgrim-<version>.apk) with the plain Android SDK tools (no Gradle).
# Needs: JDK 17, Android SDK build-tools 34.0.0 and platform android-34.
# Signing key: NOT in this repository. Point WM_KEYSTORE at your keystore and
# give its password in WM_KS_PASS (alias in WM_KS_ALIAS, default "wm").
# Without WM_KEYSTORE a throwaway debug key is made in build/ (fine for trying
# it out, but an APK signed with a different key cannot update an installed one).
set -e; cd "$(dirname "$0")"
[ -x "${JAVA_HOME:-/nonexistent}/bin/javac" ] || JAVA_HOME=$HOME/jdk17
export JAVA_HOME PATH=$JAVA_HOME/bin:$PATH
SDK=${ANDROID_HOME:-$HOME/android-sdk}
BT=$SDK/build-tools/34.0.0; JAR=$SDK/platforms/android-34/android.jar
rm -rf build; mkdir -p build/classes build/dex
$BT/aapt2 compile --dir res -o build/res.zip
$BT/aapt2 link -I $JAR --manifest AndroidManifest.xml -o build/base.apk build/res.zip --java build/gen
javac -source 8 -target 8 -nowarn -Xlint:-options -classpath $JAR -d build/classes $(find src build/gen -name '*.java')
$BT/d8 --min-api 26 --lib $JAR --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/u.apk; (cd build/dex && jar uf ../u.apk classes.dex)
$BT/zipalign -f 4 build/u.apk build/a.apk
if [ -n "$WM_KEYSTORE" ]; then
  KS=$WM_KEYSTORE; PASS=${WM_KS_PASS:?set WM_KS_PASS}; ALIAS=${WM_KS_ALIAS:-wm}
else
  KS=build/debug.keystore; PASS=android; ALIAS=debug
  keytool -genkeypair -keystore $KS -storepass $PASS -keypass $PASS -alias $ALIAS -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Smelliest Pilgrim debug" >/dev/null
  echo "NOTE: signed with a throwaway debug key (set WM_KEYSTORE for release builds)"
fi
VER=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' AndroidManifest.xml)
PASS_ENV=$PASS $BT/apksigner sign --ks "$KS" --ks-pass env:PASS_ENV --ks-key-alias "$ALIAS" --out build/SmelliestPilgrim-$VER.apk build/a.apk
rm -f build/SmelliestPilgrim-$VER.apk.idsig
$BT/apksigner verify --print-certs build/SmelliestPilgrim-$VER.apk | head -2
ls -la build/SmelliestPilgrim-$VER.apk
