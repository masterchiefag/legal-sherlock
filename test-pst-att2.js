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
                for (let i = 0; i < email.numberOfAttachments; i++) {
                    const att = email.getAttachment(i);
                    if (att.filename === 'Roserefe.doc') {
                        console.log('Att:', att.filename);
                        const buf = Buffer.alloc(8176);
                        let loops = 0;
                        while(true) {
                            const bytesRead = att.fileInputStream?.read(buf);
                            loops++;
                            console.log('Loop', loops, 'bytesRead:', bytesRead);
                            if (!bytesRead || bytesRead < 8176 || loops > 10) break;
                        }
                    }
                }
            }
            email = folder.getNextChild();
        }
    }
    if (folder.hasSubfolders) {
        for (const sub of folder.getSubFolders()) walk(sub);
    }
}
walk(pstFile.getRootFolder());
