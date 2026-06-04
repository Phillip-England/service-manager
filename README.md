# service-manager

A small Bun + Ink TUI for managing systemd service files without repeatedly navigating to `/etc/systemd/system`.

## Usage

Install it:

```sh
sudo make install
```

Then run:

```sh
service-manager
```

Or run it from the source checkout:

```sh
bun install
bun start
```

For real system service files, run it with the permissions needed to edit `/etc/systemd/system`:

```sh
sudo service-manager
```

To test against another directory:

```sh
SERVICE_DIR=/tmp/services service-manager
```

The editor defaults to `vi`. Override it with `EDITOR`:

```sh
EDITOR=vim service-manager
```

## Install Options

The default install location is `/usr/local`.

```sh
sudo make install
sudo make uninstall
```

Use `PREFIX` to choose a different location:

```sh
make install PREFIX="$HOME/.local"
```

## Commands

- `j` / `k` or arrow keys: move through service files
- `v`: view the selected service file
- `e`: edit the selected service file in `vi` or `$EDITOR`
- `c`: copy the selected service file
- `d`: delete the selected service file after confirmation
- `r`: refresh
- `q`: quit
