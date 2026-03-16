import pkg from 'pst-extractor';
const { PSTFile, PSTMessage } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pstFile = new PSTFile(path.join(__dirname, 'samples/enron.pst'));

let emailCount = 0;
function walk(folder) {
    if (folder.contentCount > 0) {
        let email = folder.getNextChild();
        while (email) {
            if (email instanceof PSTMessage) {
                emailCount++;
                console.log('Email:', emailCount, email.subject);
                for (let i = 0; i < email.numberOfAttachments; i++) {
                    const att = email.getAttachment(i);
                    console.log('Att:', att.filename, 'size:', att.attachSize);
                    const buf = Buffer.alloc(8176);
                    console.log('calling read 1...');
                    const bytesRead = att.fileInputStream?.read(buf);
                    console.log('bytesRead 1:', bytesRead);
                    console.log('calling read 2...');
                    const bytesRead2 = att.fileInputStream?.read(buf);
                    console.log('bytesRead 2:', bytesRead2);
                }
            }
            email = folder.getNextChild();
        }
    }
    if (folder.hasSubfolders) {
        for (const sub of folder.getSubFolders()) walk(sub);
    }
}
try {
    walk(pstFile.getRootFolder());
    console.log("DONE walking");
} catch(e) {
    console.error("ERROR:", e);
}
