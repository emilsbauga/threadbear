import Compression
import Foundation

/// Just enough zip to unpack the Core ML encoder from Hugging Face: iOS has no unzip API, and
/// a dependency for this one job isn't worth it. Reads the central directory, then stored or
/// deflated entries as a stream, because the encoder is over a gigabyte and can't go in memory.
/// Copied from Voice Type's iPhone app (voice-type/ios/VoiceTypeKit), which
/// unpacked the same file.
nonisolated enum MiniUnzip {
    enum Failure: Error, Equatable {
        case notAZip
        case unsupported(method: UInt16)
        case zip64
        case corrupt(String)
        case unsafePath(String)
    }

    static func extract(_ zip: URL, to destination: URL) throws {
        let handle = try FileHandle(forReadingFrom: zip)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()

        // End of central directory: at the very end, behind a comment of up to 64 KB.
        let tailLength = min(size, 66_000)
        try handle.seek(toOffset: size - tailLength)
        let tail = [UInt8](try handle.read(upToCount: Int(tailLength)) ?? Data())
        guard tail.count >= 22, let eocd = stride(from: tail.count - 22, through: 0, by: -1).first(where: {
            tail[$0] == 0x50 && tail[$0 + 1] == 0x4B && tail[$0 + 2] == 5 && tail[$0 + 3] == 6
        }) else { throw Failure.notAZip }
        let count = Int(le16(tail, eocd + 10))
        let directorySize = le32(tail, eocd + 12)
        let directoryOffset = le32(tail, eocd + 16)
        if count == 0xFFFF || directoryOffset == 0xFFFF_FFFF { throw Failure.zip64 }

        try handle.seek(toOffset: UInt64(directoryOffset))
        let directory = [UInt8](try handle.read(upToCount: Int(directorySize)) ?? Data())
        var at = 0
        for _ in 0..<count {
            guard at + 46 <= directory.count, le32(directory, at) == 0x0201_4B50 else { throw Failure.corrupt("directory") }
            let method = le16(directory, at + 10)
            let compressed = le32(directory, at + 20)
            let uncompressed = le32(directory, at + 24)
            let nameLength = Int(le16(directory, at + 28))
            let extraLength = Int(le16(directory, at + 30))
            let commentLength = Int(le16(directory, at + 32))
            let localOffset = le32(directory, at + 42)
            let name = String(decoding: directory[(at + 46)..<(at + 46 + nameLength)], as: UTF8.self)
            at += 46 + nameLength + extraLength + commentLength

            // Mac zips carry resource forks nobody wants.
            if name.hasPrefix("__MACOSX/") { continue }
            let parts = name.split(separator: "/", omittingEmptySubsequences: true)
            if name.hasPrefix("/") || parts.contains("..") { throw Failure.unsafePath(name) }
            let target = parts.reduce(destination) { $0.appendingPathComponent(String($1)) }
            if name.hasSuffix("/") {
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)

            // The data starts after the local header, whose name and extra lengths can differ
            // from the directory's.
            try handle.seek(toOffset: UInt64(localOffset))
            let local = [UInt8](try handle.read(upToCount: 30) ?? Data())
            guard local.count == 30, le32(local, 0) == 0x0403_4B50 else { throw Failure.corrupt("header of \(name)") }
            try handle.seek(toOffset: UInt64(localOffset) + 30 + UInt64(le16(local, 26)) + UInt64(le16(local, 28)))

            FileManager.default.createFile(atPath: target.path, contents: nil)
            let out = try FileHandle(forWritingTo: target)
            defer { try? out.close() }
            var written: UInt64 = 0
            switch method {
            case 0: written = try copy(from: handle, to: out, count: UInt64(compressed))
            case 8: written = try inflate(from: handle, to: out, count: UInt64(compressed), expected: UInt64(uncompressed))
            default: throw Failure.unsupported(method: method)
            }
            if written != UInt64(uncompressed) { throw Failure.corrupt("length of \(name)") }
        }
    }

    private static let chunk = 1 << 20

    private static func copy(from input: FileHandle, to output: FileHandle, count: UInt64) throws -> UInt64 {
        var left = count
        while left > 0 {
            guard let data = try input.read(upToCount: Int(min(left, UInt64(chunk)))), !data.isEmpty else { throw Failure.corrupt("short file") }
            try output.write(contentsOf: data)
            left -= UInt64(data.count)
        }
        return count
    }

    private static func inflate(from input: FileHandle, to output: FileHandle, count: UInt64, expected: UInt64) throws -> UInt64 {
        // COMPRESSION_ZLIB is raw deflate, which is what zip holds.
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else { throw Failure.corrupt("inflate") }
        defer { compression_stream_destroy(stream) }
        let outBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { outBuffer.deallocate() }

        var left = count
        var written: UInt64 = 0
        var finished = false
        while !finished {
            let before = written
            let data = left > 0 ? (try input.read(upToCount: Int(min(left, UInt64(chunk)))) ?? Data()) : Data()
            left -= UInt64(data.count)
            try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                // A placeholder pointer when there's no input left: only the output is being drained then.
                stream.pointee.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(outBuffer)
                stream.pointee.src_size = raw.count
                repeat {
                    stream.pointee.dst_ptr = outBuffer
                    stream.pointee.dst_size = chunk
                    let status = compression_stream_process(stream, left == 0 ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
                    if status == COMPRESSION_STATUS_ERROR { throw Failure.corrupt("deflate data") }
                    let produced = chunk - stream.pointee.dst_size
                    if produced > 0 {
                        try output.write(contentsOf: Data(bytes: outBuffer, count: produced))
                        written += UInt64(produced)
                    }
                    // The decoder can hand over the last byte without saying END, so the
                    // length the directory promised counts as finished too.
                    if status == COMPRESSION_STATUS_END || written == expected { finished = true }
                } while !finished && (stream.pointee.src_size > 0 || stream.pointee.dst_size == 0)
            }
            // With no input left the decoder can still be draining: only no progress at all is a failure.
            if !finished && left == 0 && data.isEmpty && written == before { throw Failure.corrupt("deflate ended early") }
        }
        return written
    }

    private static func le16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
    private static func le32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
}
