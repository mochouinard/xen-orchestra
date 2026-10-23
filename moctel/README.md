# Moctel fork of Xen Orchestra

Branch `moctel` = upstream `vatesfr/xen-orchestra` master + our patches.
`master` is a plain mirror of upstream, kept in sync by `gh repo sync`.

xen1 (10.2.10.20) builds XO from this branch through ronivay's
XenOrchestraInstallerUpdater (`/home/mochouinard/XenOrchestraInstallerUpdater`),
with `xo-install.cfg`:

    REPOSITORY="https://github.com/mochouinard/xen-orchestra"
    BRANCH="moctel"

`xo-install.sh` itself keeps one local edit, `NODEVERSION="22"`, which
`update.sh` re-applies after pulling the installer.

## Patches

- `feat(xo-web/console)`: text box on the VM console tab that types the pasted
  text on the VM keyboard (US layout). See `packages/xo-web/src/common/react-novnc.js`
  (`typeText`) and `packages/xo-web/src/xo-app/vm/tab-console.js`.
- `feat(xo-web)`: no "not bundled with any support" source banner nor weekly
  disclaimer popup (`packages/xo-web/src/xo-app/index.js`).

## Updating XO

Don't run `xo-install.sh --update` directly with an out-of-date branch; run:

    moctel/update.sh --install

It syncs the fork, rebases `moctel` on the new master, pushes it, updates the
installer on xen1, then runs the XO update. If the rebase conflicts it stops
before pushing or installing anything.

Rollback: `sudo ./xo-install.sh --rollback` on xen1 (keeps 3 builds, `PRESERVE`).
