import fs from 'fs';
import path from 'path';

// Allowed base directories to prevent reading files outside project scope
const BASE_DIRS = [
  "d:\\2026 project\\rei",
  "d:\\2026 project\\gitlab-duo",
  process.cwd()
].map(d => path.resolve(d).toLowerCase());

function isPathSafe(targetPath) {
  try {
    const resolved = path.resolve(targetPath).toLowerCase();
    return BASE_DIRS.some(base => resolved.startsWith(base) || base.startsWith(resolved));
  } catch {
    return false;
  }
}

export function executeLocalTool(name, args) {
  console.log(`[local-tools] Executing: ${name} with args:`, args);
  try {
    if (name === 'view_file') {
      const filePath = args.path || args.filePath;
      if (!filePath) return "Error: path is required";
      
      // Resolve path
      const resolvedPath = path.resolve(filePath);
      if (!isPathSafe(resolvedPath)) {
        return `Error: path "${filePath}" is outside the allowed directories.`;
      }
      
      if (!fs.existsSync(resolvedPath)) {
        return `Error: file "${filePath}" does not exist.`;
      }
      
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return `Error: "${filePath}" is not a file.`;
      }
      
      if (stat.size > 300 * 1024) {
        return `Error: file size (${(stat.size / 1024).toFixed(1)} KB) exceeds the 300 KB limit.`;
      }
      
      return fs.readFileSync(resolvedPath, 'utf8');
    }
    
    if (name === 'list_dir') {
      const dirPath = args.path || args.dirPath || '.';
      const resolvedPath = path.resolve(dirPath);
      
      if (!isPathSafe(resolvedPath)) {
        return `Error: path "${dirPath}" is outside the allowed directories.`;
      }
      
      if (!fs.existsSync(resolvedPath)) {
        return `Error: directory "${dirPath}" does not exist.`;
      }
      
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return `Error: "${dirPath}" is not a directory.`;
      }
      
      const files = fs.readdirSync(resolvedPath);
      return files.map(file => {
        const fullPath = path.join(resolvedPath, file);
        try {
          const fileStat = fs.statSync(fullPath);
          const type = fileStat.isDirectory() ? 'dir' : 'file';
          return `${type}: ${file} (${fileStat.size} bytes)`;
        } catch {
          return `unknown: ${file}`;
        }
      }).join('\n');
    }
    
    return `Error: unknown tool "${name}"`;
  } catch (err) {
    return `Error executing tool ${name}: ${err.message}`;
  }
}
