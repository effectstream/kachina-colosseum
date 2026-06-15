#!/bin/bash

# Apply patches
echo "🔧 Applying patches..."

# Function to comment out a line at specific line number
comment_line() {
    local file="$1"
    local line_num="$2"
    local comment_text="$3"
    
    if [[ -f "$file" ]]; then
        # Use sed to comment out the line (add // at the beginning)
        sed -i.bak "${line_num}s|^|// |" "$file"
        echo "✅ Commented line $line_num in $file"
    else
        echo "⚠️  Warning: File $file not found"
    fi
}

# Function to replace content in a file
replace_in_file() {
    local file="$1"
    local old_content="$2"
    local new_content="$3"
    
    if [[ -f "$file" ]]; then
        # Create backup first
        cp "$file" "$file.bak"
        
        # Use perl for more reliable string replacement
        # Only escape the search pattern, not the replacement text
        perl -i -pe "s/Q$old_contentE/$new_content/g" "$file"
        echo "✅ Replaced content in $file"
    else
        echo "⚠️  Warning: File $file not found"
    fi
}

# Function to replace content using a temp file approach for complex strings
replace_complex_content() {
    local file="$1"
    local old_content="$2"
    local new_content="$3"
    
    if [[ -f "$file" ]]; then
        # Create backup first
        cp "$file" "$file.bak"
        
        # Write old and new content to temp files
        local temp_old=$(mktemp)
        local temp_new=$(mktemp)
        printf '%s' "$old_content" > "$temp_old"
        printf '%s' "$new_content" > "$temp_new"
        
        # Use python for reliable string replacement
        python3 -c "
import sys
with open('$file', 'r') as f:
    content = f.read()
with open('$temp_old', 'r') as f:
    old = f.read()
with open('$temp_new', 'r') as f:
    new = f.read()
content = content.replace(old, new)
with open('$file', 'w') as f:
    f.write(content)
"
        
        # Clean up temp files
        rm "$temp_old" "$temp_new"
        echo "✅ Replaced complex content in $file"
    else
        echo "⚠️  Warning: File $file not found"
    fi
}

# Apply Common Hardhat Patches
shopt -s nullglob # Expands to nothing if no match is found

echo "Applying common Hardhat patches for versions 3.0.0-3.9.x..."

patch_hardhat_compiler() {
    local file_to_patch="$1"
    echo "Commenting out await stdoutFileHandle.close() in ${file_to_patch}..."
    comment_line "$file_to_patch" 48 "await stdoutFileHandle.close();"
}

patch_hardhat_utils_fs() {
    local file_to_patch="$1"
    echo "Commenting out first await fileHandle?.close() in ${file_to_patch}..."
    comment_line "$file_to_patch" 209 "await fileHandle?.close();"
    echo "Commenting out second await fileHandle?.close() in ${file_to_patch}..."
    comment_line "$file_to_patch" 275 "await fileHandle?.close();"
}

# Bun hoisted layout (node_modules/.bun)
for dir in ./node_modules/.bun/hardhat@3.[0-9]*/node_modules/hardhat/ ; do
    patch_hardhat_compiler "${dir}dist/src/internal/builtin-plugins/solidity/build-system/compiler/compiler.js"
done

for dir in ./node_modules/.bun/@nomicfoundation+hardhat-utils@3.[0-9]*/node_modules/@nomicfoundation/hardhat-utils/ ; do
    patch_hardhat_utils_fs "${dir}dist/src/fs.js"
done

# Standard npm hoisted layout
for dir in ./node_modules/hardhat/ ; do
    patch_hardhat_compiler "${dir}dist/src/internal/builtin-plugins/solidity/build-system/compiler/compiler.js"
done

for dir in ./node_modules/@nomicfoundation/hardhat-utils/ ; do
    patch_hardhat_utils_fs "${dir}dist/src/fs.js"
done

shopt -u nullglob # Revert to default

echo "✅ All patches applied successfully"

# Apply Specific Patches
echo "Replacing fetch-blob streams.cjs content..."

patch_fetch_blob() {
    local streams_file="$1"
    local from_file="$2"
    replace_complex_content "$streams_file" "  // \`node:stream/web\` got introduced in v16.5.0 as experimental
  // and it's preferred over the polyfilled version. So we also
  // suppress the warning that gets emitted by NodeJS for using it.
  try {
    const process = require('node:process')
    const { emitWarning } = process
    try {
      process.emitWarning = () => {}
      Object.assign(globalThis, require('node:stream/web'))
      process.emitWarning = emitWarning
    } catch (error) {
      process.emitWarning = emitWarning
      throw error
    }
  } catch (error) {
    // fallback to polyfill implementation
    Object.assign(globalThis, require('web-streams-polyfill/dist/ponyfill.es2018.js'))
  }" "  Object.assign(globalThis, require('web-streams-polyfill/dist/ponyfill.es2018.js'))"

    replace_complex_content "$from_file" "import { statSync, createReadStream, promises as fs } from 'node:fs'
import { basename } from 'node:path'
import DOMException from 'node-domexception'

import File from './file.js'
import Blob from './index.js'

const { stat } = fs" "import { statSync, createReadStream } from 'node:fs'
import { basename } from 'node:path'
import DOMException from 'node-domexception'

import File from './file.js'
import Blob from './index.js'

import { promises as stat } from 'node:fs'
"
}

for dir in ./node_modules/.bun/fetch-blob@3.2.0/node_modules/fetch-blob/ ./node_modules/fetch-blob/ ; do
    if [[ -d "$dir" ]]; then
        patch_fetch_blob "${dir}streams.cjs" "${dir}from.js"
    fi
done

echo "✅ All patches applied successfully"

# Apply @seriousme/opifex (MQTT engine) socket-close patch.
# Under bun, WritableStreamDefaultWriter.close() on an already-closed/errored
# stream REJECTS asynchronously instead of throwing synchronously, so the
# library's try/catch around `this.writer.close()` misses it. The escaped
# rejection is fatal (effection's main() tears down the node -> exit 1) and
# crash-loops the node every MQTT reconnect. Attach a .catch to swallow it.
echo "Patching @seriousme/opifex socket close()..."

patch_opifex_socket() {
    local socket_file="$1"
    if [[ -f "$socket_file" ]]; then
        replace_complex_content "$socket_file" "                this.writer.close();" "                Promise.resolve(this.writer.close()).catch(() => {});"
    fi
}

shopt -s nullglob
for f in ./node_modules/.bun/@seriousme+opifex@*/node_modules/@seriousme/opifex/dist/socket/socket.js \
         ./node_modules/@seriousme/opifex/dist/socket/socket.js ; do
    patch_opifex_socket "$f"
done
shopt -u nullglob

echo "✅ All patches applied successfully"
        
        