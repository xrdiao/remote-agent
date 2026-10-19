#!/usr/bin/env bash
# Archive the iOS app without a registered device, then export it (upload to App Store Connect by default).
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=ios/AgentRemote.xcodeproj
BUILD="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
DEST="${DESTINATION:-upload}"
WORK=ios/build/testflight
ARCHIVE="$WORK/AgentRemote.xcarchive"
EXPORT="$WORK/export"

settings=$(xcodebuild -project "$PROJECT" -scheme AgentRemote -configuration Release -showBuildSettings)
setting() { sed -n "s/^ *$1 = //p" <<<"$settings" | head -n 1; }
team=$(setting DEVELOPMENT_TEAM)
bundle=$(setting PRODUCT_BUNDLE_IDENTIFIER)
version=$(setting MARKETING_VERSION)
if [[ -z "$team" || -z "$bundle" ]]; then
  echo "在 ios/Local.xcconfig 里填 DEVELOPMENT_TEAM 和 PRODUCT_BUNDLE_IDENTIFIER"
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

echo "归档 ${bundle} ${version}（build ${BUILD}）"
xcodebuild -project "$PROJECT" -scheme AgentRemote -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" archive \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD"

APP="$ARCHIVE/Products/Applications/AgentRemote.app"
# The archive is unsigned (no registered device needed); ad-hoc sign it inside-out so the
# export sees the entitlements (aps-environment) and carries them into the App Store signature.
for ext in "$APP"/PlugIns/*.appex; do [[ -e "$ext" ]] && codesign --force --sign - "$ext"; done
codesign --force --sign - --entitlements ios/AgentRemote.entitlements "$APP"

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>${DEST}</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${team}</string>
</dict>
</plist>
EOF

echo "导出（destination=${DEST}）"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -exportPath "$EXPORT" -allowProvisioningUpdates

if [[ "$DEST" == "upload" ]]; then
  echo "已上传 ${version}（build ${BUILD}）。App Store Connect 处理需要几分钟，之后会出现在 TestFlight。"
else
  echo "已导出到 ${EXPORT}（DESTINATION=${DEST}，未上传）。"
fi
