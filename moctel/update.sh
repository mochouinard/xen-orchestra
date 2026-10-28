#!/bin/bash
# Rebase the moctel branch on the latest vatesfr/xen-orchestra master, push it
# to the fork, then (with --install) update XO on xen1 from that branch.
#
# Run from a workstation that has `gh` logged in as mochouinard:
#   moctel/update.sh            # sync fork + rebase/push moctel only
#   moctel/update.sh --install  # same, then update the installer and XO on xen1
set -euo pipefail

FORK=mochouinard/xen-orchestra
BRANCH=moctel
XO_HOST=mochouinard@10.2.10.20
INSTALLER_DIR=/home/mochouinard/XenOrchestraInstallerUpdater
NODE_PIN=22 # xen1 (Debian 11) stays on node 22

cd "$(git rev-parse --show-toplevel)"
gitgh() { git -c credential.helper= -c credential.helper='!gh auth git-credential' "$@"; }

if [[ -n $(git status --porcelain) ]]; then
    echo "local changes in $(pwd), commit or stash them first" >&2
    exit 1
fi

echo "== sync fork master with upstream"
gh repo sync "$FORK" -b master

echo "== rebase $BRANCH on master"
gitgh fetch -q origin "+refs/heads/master:refs/remotes/origin/master" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git checkout -q "$BRANCH"
git reset -q --hard "origin/$BRANCH"
remote_head=$(git rev-parse "origin/$BRANCH")
if ! git rebase -q origin/master; then
    git rebase --abort
    echo "rebase conflict: fix $BRANCH by hand (git rebase origin/master), nothing was pushed" >&2
    exit 1
fi
gitgh push -q --force-with-lease="$BRANCH:$remote_head" origin "$BRANCH"
git log --oneline -1 origin/master
git log --oneline origin/master.."$BRANCH"

[[ ${1:-} == --install ]] || exit 0

echo "== update installer and XO on $XO_HOST"
ssh -t "$XO_HOST" "set -e
cd $INSTALLER_DIR
sudo git -c safe.directory='*' checkout -q xo-install.sh
sudo git -c safe.directory='*' pull -q --ff-only
sudo sed -i 's/^NODEVERSION=.*/NODEVERSION=\"$NODE_PIN\"/' xo-install.sh
grep -E '^(REPOSITORY|BRANCH)=' xo-install.cfg
sudo ./xo-install.sh --update"
