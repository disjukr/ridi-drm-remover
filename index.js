const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const bplist = require('bplist-parser');
const mkdirp = require('mkdirp');
const unzip = require('unzip');
const username = require('username');

async function main() {
    const systemUsername = await username();
    const deviceId = await getDeviceId(systemUsername);
    for (let ridiUsername of await getRidiUserNames()) {
        const savePath = `save-here/${ ridiUsername }`;
        await asyncMkdirp(savePath);
        const libraryPath = await getLibraryPath(ridiUsername);
        for (let bookId of await getChildFoldersShallow(libraryPath)) {
            let type, fd;
            try {
                [type, fd] = await openEbook(libraryPath, bookId);
            } catch (e) {
                console.log(bookId, 'unsupported or not downloaded yet');
                continue;
            }
            console.log(bookId, type);
            if (type === 'zip') {
                await saveZipTypeEbook(deviceId, fd, path.join(savePath, bookId));
            } else {
                const contentKey = await decryptKeyFile(deviceId, libraryPath, bookId);
                switch (type) {
                case 'pdf': await savePdfTypeEbook(contentKey, fd, path.join(savePath, `${ bookId }.pdf`)); break;
                case 'epub': await saveEpubTypeEbook(contentKey, fd, path.join(savePath, `${ bookId }.epub`)); break;
                }
            }
        }
    }
}

main();

async function savePdfTypeEbook(contentKey, fd, savePath) {
    const decipher = crypto.createDecipheriv(
        'aes-128-cbc',
        contentKey,
        Buffer.alloc(16, 0),
    );
    const data = decipher.update(await asyncReadFile(fd)).slice(16);
    await asyncWriteFile(savePath, data);
}

async function saveEpubTypeEbook(contentKey, fd, savePath) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', contentKey, '');
    const data = decipher.update(await asyncReadFile(fd));
    await asyncWriteFile(savePath, data);
}

function saveZipTypeEbook(deviceId, fd, savePath) {
    async function decryptAndSavePage(pageStream, deviceId, savePath) {
        const decipher = crypto.createDecipheriv('aes-128-ecb', deviceId.substring(2, 18), '');
        const data = decipher.update(await streamToBuffer(pageStream));
        await asyncWriteFile(savePath, data);
    }
    return new Promise((resolve, reject) => {
        mkdirp(savePath, err => {
            if (err) return reject(err);
            const jobs = [];
            fs.createReadStream(null, { fd }).pipe(unzip.Parse()).on('entry', entry => {
                const [filePath, fileType] = [entry.path, entry.type];
                jobs.push(
                    fileType === 'File' ?
                    decryptAndSavePage(entry, deviceId, path.join(savePath, filePath)) :
                    drain(entry)
                );
            }).on('finish', () => Promise.all(jobs).then(resolve));
        });
    });
}

/**
 * @returns {Buffer}
 */
async function streamToBuffer(stream) {
    return new Promise(resolve => {
        const buffers = [];
        stream.on('data', buffer => buffers.push(buffer));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

async function drain(stream) {
    return new Promise(resolve => {
        stream.on('readable', () => stream.read());
        stream.on('end', resolve);
    });
}

/**
 * @param {string} libraryPath 
 * @param {string} bookId 
 * @returns {['pdf' | 'epub' | 'zip', number]}
 */
async function openEbook(libraryPath, bookId) {
    for (let type of ['pdf', 'epub', 'zip']) {
        try {
            return [ type, await asyncOpen(
                path.join(libraryPath, bookId, `${ bookId }.${ type }`),
                'r',
            ) ];
        } catch (e) {
            continue;
        }
    }
    throw new Error('unsupported ebook type');
}

async function getRidiUserNames() {
    const systemUsername = await username();
    return (await getChildFoldersShallow(`/Users/${ systemUsername }/Library/Application Support/RIDI/Ridibooks/`)).filter(
        folder => (folder !== 'QtWebEngine') && (folder !== 'fontcache')
    );
}

async function getLibraryPath(ridiUsername) {
    const systemUsername = await username();
    return `/Users/${ systemUsername }/Library/Application Support/RIDI/Ridibooks/${ ridiUsername }/library`;
}

async function decryptKeyFile(deviceId, libraryPath, bookId) {
    const idLength = deviceId.length;
    const keyFilePath = path.join(libraryPath, bookId, `${ bookId }.dat`);
    const decKey = deviceId.substr(0, 16).replace(/-/g, '');
    const sc = new SimpleCrypt(decKey);
    const keyFile = await asyncReadFile(keyFilePath);
    const ecbKey = Buffer.from(deviceId.substr(0, 16), 'binary');
    const decipher = crypto.createDecipheriv('aes-128-ecb', ecbKey, '');
    const contentKey = decipher.update(
        Buffer.from(sc.decrypt(keyFile), 'binary')
    ).slice(idLength, idLength + 64).slice(32, 48);
    return contentKey;
}

async function getDeviceId(systemUsername) {
    const plist = await parseBplist(`/Users/${ systemUsername }/Library/Preferences/com.ridibooks.Ridibooks.plist`);
    const sc = new SimpleCrypt('0c2f1bb4acb9f023');
    return sc.decrypt(Buffer.from(plist[0]['device.device_id'], 'base64'));
}

function parseBplist(filePath) {
    return new Promise((resolve, reject) => {
        bplist.parseFile(filePath, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function asyncMkdirp(dir) {
    return new Promise((resolve, reject) => mkdirp(
        dir,
        (err, made) => err ? reject(err) : resolve(made),
    ));
}

const asyncOpen = promisify(fs.open);
const asyncReadFile = promisify(fs.readFile);
const asyncWriteFile = promisify(fs.writeFile);
const asyncReaddir = promisify(fs.readdir);
const asyncStat = promisify(fs.stat);

async function getChildFoldersShallow(dir) {
    const items = await asyncReaddir(dir);
    return (await Promise.all(
        items.map(async item => [item, await asyncStat(path.join(dir, item))])
    )).filter(
        ([item, stats]) => stats.isDirectory()
    ).map(([item]) => item);
}

class SimpleCrypt {
    constructor(key) {
        this._parts = key.match(/../g).map(part => parseInt(part, 16)).reverse();
    }
    /**
     * @param {string | Buffer} text
     */
    decrypt(text) {
        const ctext = (
            typeof text === 'string' ?
            Buffer.from(text, 'binary') :
            text
        ).slice(2);
        const pt = Buffer.alloc(ctext.length);
        let lc = 0;
        for (let i = 0; i < ctext.length; ++i) {
            const c = ctext.readUInt8(i);
            pt.writeUInt8(c ^ lc ^ this._parts[i % 8], i);
            lc = c;
        }
        return pt.slice(1).toString('binary').slice(2);
    }
}
