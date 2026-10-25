const fs = require('fs');
const path = require('path');
const https = require('https');

const modelsDir = path.join(__dirname, 'public', 'models');
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

const baseUrl = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
const files = [
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_recognition_model-shard2"
];

console.log("⬇️  Starting download of AI Models...");

files.forEach(file => {
    const filePath = path.join(modelsDir, file);
    const fileUrl = `${baseUrl}/${file}`;
    const fileStream = fs.createWriteStream(filePath);

    https.get(fileUrl, response => {
        response.pipe(fileStream);
        fileStream.on('finish', () => {
            fileStream.close();
            console.log(`✅ Downloaded: ${file}`);
        });
    }).on('error', err => {
        fs.unlink(filePath, () => {}); // Delete partial file
        console.error(`❌ Error downloading ${file}:`, err.message);
    });
});