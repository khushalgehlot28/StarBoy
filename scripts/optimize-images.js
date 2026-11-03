const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

async function optimizeImages() {
  const imageDirectory = path.join(__dirname, '..', 'public', 'assets', 'images');
  const filenames = await fs.readdir(imageDirectory);
  const sources = filenames.filter(filename => /\.(jpe?g)$/i.test(filename));

  for (const filename of sources) {
    const sourcePath = path.join(imageDirectory, filename);
    const outputPath = path.join(imageDirectory, filename.replace(/\.jpe?g$/i, '.webp'));
    await sharp(sourcePath).webp({ quality: 82, effort: 5 }).toFile(outputPath);
    console.log(`Optimized ${filename} -> ${path.basename(outputPath)}`);
  }
}

optimizeImages().catch(error => {
  console.error('Image optimization failed:', error);
  process.exitCode = 1;
});
