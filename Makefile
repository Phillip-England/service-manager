PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
LIBDIR ?= $(PREFIX)/lib/service-manager
BIN ?= service-manager
BUN ?= bun
INSTALL ?= install
RMR ?= rm -rf

.PHONY: install uninstall check

check:
	$(BUN) run check

install: check
	$(INSTALL) -d "$(DESTDIR)$(BINDIR)" "$(DESTDIR)$(LIBDIR)/src"
	$(INSTALL) -m 644 package.json bun.lock README.md "$(DESTDIR)$(LIBDIR)/"
	$(INSTALL) -m 755 src/index.jsx "$(DESTDIR)$(LIBDIR)/src/index.jsx"
	cd "$(DESTDIR)$(LIBDIR)" && $(BUN) install --production --frozen-lockfile
	printf '%s\n' '#!/usr/bin/env sh' \
		'exec $(BUN) run "$(LIBDIR)/src/index.jsx" "$$@"' \
		> "$(DESTDIR)$(BINDIR)/$(BIN)"
	chmod 755 "$(DESTDIR)$(BINDIR)/$(BIN)"
	@printf 'Installed %s to %s\n' "$(BIN)" "$(DESTDIR)$(BINDIR)/$(BIN)"

uninstall:
	$(RMR) "$(DESTDIR)$(BINDIR)/$(BIN)" "$(DESTDIR)$(LIBDIR)"
	@printf 'Uninstalled %s\n' "$(BIN)"
