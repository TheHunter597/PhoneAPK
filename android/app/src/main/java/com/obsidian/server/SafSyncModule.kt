package com.obsidian.server

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.io.File

/**
 * SafSyncModule — Kotlin-side bridge for the Storage Access Framework.
 *
 * Exposes two methods to JavaScript:
 *
 *   1. copyTreeToInternal(treeUri: String): Promise<String>
 *      Walks the picked SAF tree and copies every file into the app's
 *      internal files directory: /data/data/<pkg>/files/vault/
 *      Returns the destination absolute POSIX path so Node.js can read/write
 *      to it directly with `fs`.
 *
 *   2. exportToOriginalUri(treeUri: String, internalPath: String): Promise<Void>
 *      Walks the internal vault directory and copies every file back into
 *      the original SAF tree. Used by the optional "Export to original folder"
 *      flow.
 *
 * Why this exists:
 *   Node.js (running via nodejs-mobile) only understands POSIX file paths.
 *   Android's Storage Access Framework returns content:// URIs that cannot
 *   be opened with `fs.readFile`. We bridge the gap by copying the entire
 *   tree into app-private storage once on first launch, then writing back
 *   to the SAF tree on demand.
 *
 * Performance note:
 *   For very large vaults (>10k files), the copy is O(n) and runs on a
 *   background thread. We log progress every 100 files so the user sees
 *   activity in logcat. A future optimisation could use DocumentFile's
 *   persistence API to keep the tree URI granted across launches, but
 *   for the MVP we copy once + on every "import" action.
 */
@ReactModule(name = SafSyncModule.NAME)
class SafSyncModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = NAME

    @ReactMethod
    fun copyTreeToInternal(treeUri: String, promise: Promise) {
        try {
            val uri = Uri.parse(treeUri)
            val destDir = File(ctx.filesDir, "vault")
            // Wipe the destination first so re-imports don't leave stale files.
            if (destDir.exists()) destDir.deleteRecursively()
            destDir.mkdirs()

            val treeDocumentId = DocumentsContract.getTreeDocumentId(uri)
            val treeUriChildren = DocumentsContract.buildChildDocumentsUriUsingTree(
                uri,
                treeDocumentId,
            )

            var copied = 0
            val contentResolver = ctx.contentResolver
            contentResolver.query(treeUriChildren, arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            ), null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val docId = cursor.getString(0)
                    val mime = cursor.getString(1)
                    val name = cursor.getString(2) ?: continue
                    val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
                    val childUri = DocumentsContract.buildDocumentUriUsingTree(uri, docId)
                    if (isDir) {
                        copyDirRecursive(contentResolver, uri, docId, File(destDir, name))
                    } else {
                        copyFile(contentResolver, childUri, File(destDir, name))
                    }
                    copied++
                    if (copied % 100 == 0) {
                        Log.i(TAG, "copyTreeToInternal: $copied files copied…")
                    }
                }
            }

            Log.i(TAG, "copyTreeToInternal: done — $copied entries under ${destDir.absolutePath}")
            promise.resolve(destDir.absolutePath)
        } catch (err: Throwable) {
            Log.e(TAG, "copyTreeToInternal failed", err)
            promise.reject("E_SAF_COPY", err.message, err)
        }
    }

    @ReactMethod
    fun exportToOriginalUri(treeUri: String, internalPath: String, promise: Promise) {
        try {
            val uri = Uri.parse(treeUri)
            val srcDir = File(internalPath)
            if (!srcDir.isDirectory) {
                promise.reject("E_NO_SRC", "Internal vault path is not a directory: $internalPath")
                return
            }
            val contentResolver = ctx.contentResolver
            val treeDocumentId = DocumentsContract.getTreeDocumentId(uri)

            // Walk the internal vault and write each file back to the SAF tree.
            var exported = 0
            srcDir.walkTopDown().forEach { srcFile ->
                if (srcFile.isDirectory) return@forEach
                val rel = srcFile.relativeTo(srcDir).path
                // Build the destination URI: <tree>/<rel> with each segment as a child document.
                val segments = rel.split(File.separatorChar)
                var currentDocId = treeDocumentId
                for ((i, seg) in segments.withIndex()) {
                    val isLast = i == segments.lastIndex
                    currentDocId = findOrCreateChild(contentResolver, uri, currentDocId, seg, isLast)
                    if (currentDocId == null) {
                        Log.w(TAG, "export: could not resolve/create segment '$seg' in path '$rel'")
                        return@forEach
                    }
                }
                // currentDocId now points to the destination file document.
                val destFileUri = DocumentsContract.buildDocumentUriUsingTree(uri, currentDocId)
                contentResolver.openOutputStream(destFileUri, "wt")?.use { out ->
                    srcFile.inputStream().use { it.copyTo(out) }
                }
                exported++
                if (exported % 100 == 0) {
                    Log.i(TAG, "exportToOriginalUri: $exported files exported…")
                }
            }
            Log.i(TAG, "exportToOriginalUri: done — $exported files exported")
            promise.resolve(null)
        } catch (err: Throwable) {
            Log.e(TAG, "exportToOriginalUri failed", err)
            promise.reject("E_SAF_EXPORT", err.message, err)
        }
    }

    // -------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------

    private fun copyDirRecursive(
        cr: android.content.ContentResolver,
        treeUri: Uri,
        parentDocId: String,
        destDir: File,
    ) {
        destDir.mkdirs()
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        cr.query(childrenUri, arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        ), null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val docId = cursor.getString(0)
                val mime = cursor.getString(1)
                val name = cursor.getString(2) ?: continue
                val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
                val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                if (isDir) {
                    copyDirRecursive(cr, treeUri, docId, File(destDir, name))
                } else {
                    copyFile(cr, childUri, File(destDir, name))
                }
            }
        }
    }

    private fun copyFile(cr: android.content.ContentResolver, srcUri: Uri, destFile: File) {
        destFile.parentFile?.mkdirs()
        cr.openInputStream(srcUri)?.use { input ->
            destFile.outputStream().use { input.copyTo(it) }
        }
    }

    /**
     * Find or create a child document with the given display name under
     * [parentDocId]. If [createAsDir] is false and we're at the leaf segment,
     * create a file document. Returns the document id, or null on failure.
     */
    private fun findOrCreateChild(
        cr: android.content.ContentResolver,
        treeUri: Uri,
        parentDocId: String,
        name: String,
        createAsFile: Boolean,
    ): String? {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        // First, look for an existing child with the matching name.
        cr.query(childrenUri, arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        ), null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val docId = cursor.getString(0)
                val displayName = cursor.getString(1)
                val mime = cursor.getString(2)
                if (displayName == name) {
                    // If we need a dir and this is a dir, or we need a file and this is a file, return it.
                    val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
                    if (createAsFile != isDir) return docId
                }
            }
        }
        // Not found — create it.
        val mime = if (createAsFile) guessMimeFromName(name) else DocumentsContract.Document.MIME_TYPE_DIR
        return try {
            val newDocUri = DocumentsContract.createDocument(
                cr,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, parentDocId),
                mime,
                name,
            ) ?: return null
            DocumentsContract.getDocumentId(newDocUri)
        } catch (err: Throwable) {
            Log.w(TAG, "createDocument failed for '$name' under $parentDocId: ${err.message}")
            null
        }
    }

    private fun guessMimeFromName(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "md" -> "text/markdown"
            "txt" -> "text/plain"
            "html", "htm" -> "text/html"
            "css" -> "text/css"
            "js" -> "application/javascript"
            "json" -> "application/json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "pdf" -> "application/pdf"
            else -> "application/octet-stream"
        }
    }

    companion object {
        const val NAME = "SafSync"
        private const val TAG = "SafSyncModule"
    }
}
