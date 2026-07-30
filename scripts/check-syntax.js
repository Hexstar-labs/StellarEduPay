const { execSync } = require('child_process');
const { globSync } = require('glob');

const files = globSync('backend/src/**/*.js', { ignore: '**/node_modules/**' });
let failed = false;

for (const file of files) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    console.error(`SYNTAX ERROR in ${file}:\n${err.stderr.toString()}`);
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log(`✓ ${files.length} files passed node --check`);
}