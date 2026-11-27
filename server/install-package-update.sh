#!/bin/sh
set -u

package_manager="$1"
package_path="$2"
status_path="$3"
target_version="$4"
unit_name="$5"
package_directory="$6"

case "$package_manager" in
  apt-get)
    "$package_manager" install -y --no-install-recommends "$package_path"
    result=$?
    ;;
  dnf|yum)
    "$package_manager" install -y "$package_path"
    result=$?
    ;;
  *)
    echo "Unsupported package manager: $package_manager" >&2
    result=64
    ;;
esac

status="failed"
if [ "$result" -eq 0 ]; then
  status="installed"
fi

temporary_status="${status_path}.tmp.$$"
printf '{"status":"%s","targetVersion":"%s","unitName":"%s","exitCode":%s,"completedAt":"%s"}\n' \
  "$status" "$target_version" "$unit_name" "$result" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary_status"
chmod 600 "$temporary_status"
mv -f "$temporary_status" "$status_path"
rm -rf -- "$package_directory"
exit "$result"
