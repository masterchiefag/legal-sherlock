import pkg from 'pst-extractor';
const { PSTFile, PSTMessage } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pstFile = new PSTFile(path.join(__dirname, 'samples/enron.pst'));

function walk(folder) {
    if (folder.contentCount > 0) {
        let email = folder.getNextChild();
        while (email) {
            for (let i = 0; i < email.numberOfAttachments; i++) {
                const att = email.getAttachment(i);
                const streamLength = att.fileInputStream?.length?.toNumber() || 0;
                console.log('Att:', att.filename, 'streamLength:', streamLength);
                
                if (streamLength > 0) {
                    let totalWritten = 0;
                    let loops = 0;
                    
                    while (totalWritten < streamLength) {
                        const remaining = streamLength - totalWritten;
                        const chunkSize = Math.min(8176, remaining);
                        const buf = Buffer.alloc(chunkSize);
                        
                        const bytesRead = att.fileInputStream?.read(buf);
                        totalWritten += chunkSize; // Assuming it read completely as we bounded it
                        loops++;
                        // console.log('Loop', loops, 'bytesRead:', bytesRead, 'totalWritten:', totalWritten);
                    }
                    console.log('Finished streaming attachment safely in', loops, 'loops');
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
console.log("SUCCESSFULLY COMPLETED!");
