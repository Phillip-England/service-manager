#!/usr/bin/env bun
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {render, Box, Text, useApp, useInput, useStdin} from 'ink';
import {basename, join} from 'node:path';
import {copyFile, mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {closeSync, constants, openSync} from 'node:fs';
import {spawn} from 'node:child_process';

const DEFAULT_SERVICE_DIR = '/etc/systemd/system';
const SERVICE_DIR = process.env.SERVICE_DIR || DEFAULT_SERVICE_DIR;
const EDITOR = process.env.EDITOR || 'vi';
const VISIBLE_ROWS = 14;
const VERSION = '0.1.0';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`service-manager ${VERSION}

Usage:
  service-manager
  SERVICE_DIR=/tmp/services service-manager
  EDITOR=vim service-manager

Commands:
  j/k or arrows  Move through service files
  v              View selected service file
  e              Edit selected service file in vi or $EDITOR
  c              Copy selected service file
  d              Delete selected service file after confirmation
  r              Refresh
  q              Quit`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

function formatError(error) {
  if (!error) return '';
  if (error.code === 'ENOENT') return 'Service directory does not exist.';
  if (error.code === 'EACCES') return 'Permission denied. Run with sudo for protected service files.';
  return error.message || String(error);
}

async function loadServices() {
  const entries = await readdir(SERVICE_DIR, {withFileTypes: true});
  const services = await Promise.all(
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.service'))
      .map(async entry => {
        const path = join(SERVICE_DIR, entry.name);
        const info = await stat(path);
        return {
          name: entry.name,
          path,
          size: info.size,
          modifiedAt: info.mtime
        };
      })
  );

  return services.sort((a, b) => a.name.localeCompare(b.name));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeServiceName(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fileName = basename(trimmed);
  return fileName.endsWith('.service') ? fileName : `${fileName}.service`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[2J\x1b[H');
}

function openTtyStdio() {
  const fds = [];

  try {
    fds.push(openSync('/dev/tty', 'r'));
    fds.push(openSync('/dev/tty', 'w'));
    fds.push(openSync('/dev/tty', 'w'));

    return {
      stdio: fds,
      close() {
        for (const fd of fds) closeSync(fd);
      }
    };
  } catch {
    for (const fd of fds) closeSync(fd);

    return {
      stdio: 'inherit',
      close() {}
    };
  }
}

function runEditor(filePath) {
  const tty = openTtyStdio();
  let settled = false;

  const finish = result => {
    if (settled) return;
    settled = true;
    tty.close();
    return result;
  };

  return new Promise(resolve => {
    const child = spawn(`${EDITOR} ${shellQuote(filePath)}`, {
      shell: true,
      stdio: tty.stdio
    });

    child.on('exit', code => {
      resolve(finish({code}));
    });

    child.on('error', error => {
      resolve(finish({error}));
    });
  });
}

function ViewPane({content, offset, selected}) {
  const lines = content.split('\n');
  const visible = lines.slice(offset, offset + VISIBLE_ROWS);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width="100%">
      <Text color="cyan">Viewing {selected.name}</Text>
      {visible.map((line, index) => (
        <Text key={`${offset}-${index}`}>
          <Text color="gray">{String(offset + index + 1).padStart(4, ' ')} </Text>
          {line || ' '}
        </Text>
      ))}
      <Text color="gray">
        j/k scroll, esc close, {offset + 1}-{Math.min(offset + VISIBLE_ROWS, lines.length)} of {lines.length}
      </Text>
    </Box>
  );
}

function Prompt({label, value, help}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="yellow">{label}</Text>
      <Text>
        <Text color="cyan">&gt; </Text>
        {value}
      </Text>
      <Text color="gray">{help}</Text>
    </Box>
  );
}

function App() {
  const {exit, waitUntilRenderFlush} = useApp();
  const {setRawMode, isRawModeSupported} = useStdin();
  const [services, setServices] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('list');
  const [viewContent, setViewContent] = useState('');
  const [viewOffset, setViewOffset] = useState(0);
  const [copyName, setCopyName] = useState('');

  const selected = services[selectedIndex];
  const isDefaultDir = SERVICE_DIR === DEFAULT_SERVICE_DIR;

  const reload = useCallback(async message => {
    setLoading(true);
    setError('');
    try {
      const nextServices = await loadServices();
      setServices(nextServices);
      setSelectedIndex(index => clamp(index, 0, Math.max(0, nextServices.length - 1)));
      setStatus(message || `Loaded ${nextServices.length} service file${nextServices.length === 1 ? '' : 's'}.`);
    } catch (loadError) {
      setServices([]);
      setSelectedIndex(0);
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const visibleServices = useMemo(() => {
    const start = clamp(selectedIndex - Math.floor(VISIBLE_ROWS / 2), 0, Math.max(0, services.length - VISIBLE_ROWS));
    return {
      start,
      rows: services.slice(start, start + VISIBLE_ROWS)
    };
  }, [services, selectedIndex]);

  async function openSelected() {
    if (!selected) return;

    try {
      const content = await readFile(selected.path, 'utf8');
      setViewContent(content);
      setViewOffset(0);
      setMode('view');
      setStatus('');
    } catch (readError) {
      setStatus(formatError(readError));
    }
  }

  async function editSelected() {
    if (!selected) return;

    setMode('editing');
    setStatus(`Opening ${selected.name} in ${EDITOR}...`);
    setRawMode(false);
    process.stdin.pause();

    await waitUntilRenderFlush();
    clearTerminal();

    const result = await runEditor(selected.path);

    clearTerminal();
    if (isRawModeSupported) setRawMode(true);
    process.stdin.resume();
    setMode('list');

    if (result.error) {
      setStatus(formatError(result.error));
      return;
    }

    await reload(result.code === 0 ? `Returned from ${EDITOR}.` : `${EDITOR} exited with code ${result.code}.`);
  }

  async function copySelected() {
    if (!selected) return;

    const targetName = sanitizeServiceName(copyName);
    if (!targetName) {
      setStatus('Enter a destination service name.');
      return;
    }

    const targetPath = join(SERVICE_DIR, targetName);
    try {
      await mkdir(SERVICE_DIR, {recursive: true});
      await copyFile(selected.path, targetPath, constants.COPYFILE_EXCL);
      setCopyName('');
      setMode('list');
      await reload(`Copied ${selected.name} to ${targetName}.`);
    } catch (copyError) {
      if (copyError.code === 'EEXIST') {
        setStatus(`${targetName} already exists.`);
      } else {
        setStatus(formatError(copyError));
      }
    }
  }

  async function deleteSelected() {
    if (!selected) return;

    try {
      const deletedName = selected.name;
      await rm(selected.path);
      setMode('list');
      await reload(`Deleted ${deletedName}.`);
    } catch (deleteError) {
      setStatus(formatError(deleteError));
    }
  }

  useInput((input, key) => {
    if (mode === 'editing') return;

    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (mode === 'view') {
      const maxOffset = Math.max(0, viewContent.split('\n').length - VISIBLE_ROWS);
      if (key.escape || input === 'q') setMode('list');
      if (key.upArrow || input === 'k') setViewOffset(offset => clamp(offset - 1, 0, maxOffset));
      if (key.downArrow || input === 'j') setViewOffset(offset => clamp(offset + 1, 0, maxOffset));
      if (key.pageUp) setViewOffset(offset => clamp(offset - VISIBLE_ROWS, 0, maxOffset));
      if (key.pageDown) setViewOffset(offset => clamp(offset + VISIBLE_ROWS, 0, maxOffset));
      return;
    }

    if (mode === 'copy') {
      if (key.escape) {
        setCopyName('');
        setMode('list');
        return;
      }
      if (key.return) {
        copySelected();
        return;
      }
      if (key.backspace || key.delete) {
        setCopyName(value => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setCopyName(value => `${value}${input}`);
      return;
    }

    if (mode === 'delete') {
      if (input === 'y' || input === 'Y') deleteSelected();
      if (input === 'n' || input === 'N' || key.escape) setMode('list');
      return;
    }

    if (input === 'q') exit();
    if (input === 'r') reload();
    if (selected && input === 'v') openSelected();
    if (selected && input === 'e') editSelected();
    if (selected && input === 'c') {
      setCopyName(selected.name.replace(/\.service$/, '-copy.service'));
      setMode('copy');
    }
    if (selected && input === 'd') setMode('delete');
    if (key.upArrow || input === 'k') setSelectedIndex(index => clamp(index - 1, 0, Math.max(0, services.length - 1)));
    if (key.downArrow || input === 'j') setSelectedIndex(index => clamp(index + 1, 0, Math.max(0, services.length - 1)));
  }, {isActive: isRawModeSupported && mode !== 'editing'});

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>service-manager</Text>
        <Text color="gray">Directory: {SERVICE_DIR}</Text>
        {isDefaultDir && <Text color="gray">Protected files usually require running this command with sudo.</Text>}
        {!isRawModeSupported && <Text color="yellow">Interactive input requires a TTY.</Text>}
      </Box>

      {loading && <Text color="yellow">Loading service files...</Text>}
      {error && <Text color="red">{error}</Text>}

      {!loading && !error && mode !== 'view' && (
        <Box flexDirection="column" borderStyle="single" paddingX={1}>
          {services.length === 0 && <Text color="gray">No .service files found.</Text>}
          {visibleServices.rows.map((service, rowIndex) => {
            const index = visibleServices.start + rowIndex;
            const active = index === selectedIndex;
            return (
              <Text key={service.path} color={active ? 'cyan' : undefined}>
                {active ? '>' : ' '} {service.name.padEnd(38, ' ')}
                <Text color="gray"> {service.size.toString().padStart(7, ' ')} bytes</Text>
              </Text>
            );
          })}
        </Box>
      )}

      {mode === 'view' && selected && <ViewPane content={viewContent} offset={viewOffset} selected={selected} />}

      {mode === 'copy' && selected && (
        <Prompt label={`Copy ${selected.name} to:`} value={copyName} help="Enter to copy, esc to cancel." />
      )}

      {mode === 'delete' && selected && (
        <Box borderStyle="single" paddingX={1}>
          <Text color="red">Delete {selected.name}? Press y to confirm or n to cancel.</Text>
        </Box>
      )}

      {mode === 'editing' && <Text color="yellow">Editor is active. Save and quit {EDITOR} to return.</Text>}

      {status && <Text color={status.includes('denied') || status.includes('exists') || status.includes('exited') ? 'red' : 'green'}>{status}</Text>}

      <Text color="gray">
        Commands: j/k or arrows move, v view, e edit, c copy, d delete, r refresh, q quit
      </Text>
    </Box>
  );
}

render(<App />);
