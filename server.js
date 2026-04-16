// server.js (fixed)
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@notionhq/client');
const multer = require("multer");
const cors = require('cors');
const dotenv = require('dotenv');
const FormData = require('form-data');
const axios = require('axios');
const mime = require('mime-types');

dotenv.config();
const upload = multer();
const app = express();
app.disable('etag');

app.use(cors({
    credentials: true,
    origin: [
        'https://localhost:3000',
        'https://codewithabubakr.github.io',
    ]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';
const NOTION_VERSION = '2022-06-28';

// Validate env
if (!process.env.NOTION_API_KEY) {
    console.error("Missing NOTION_API_KEY in env — set it before starting server.");
    process.exit(1);
}
if (!process.env.NOTION_DASHBOARD_ID) {
    console.error("Missing NOTION_DASHBOARD_ID (target database ID) in env.");
    process.exit(1);
}
if (!process.env.NOTION_CASE_DB_ID) {
    console.error("Missing NOTION_CASE_DB_ID (cases DB ID) in env.");
    process.exit(1);
}

const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

const dashboardId = process.env.NOTION_DASHBOARD_ID;
const CASE_DB_ID = process.env.NOTION_CASE_DB_ID;

app.post("/add-task", upload.array("files"), async (req, res) => {
    try {
        const fileName = req.body.fileName || req.body.file_name || req.body.filename;
        const date = req.body.date || null;
        const link = req.body.link || null;
        const messageId = req.body.messageId || req.body.message_id || null;
        const linkedCase = req.body.linkedCase || req.body.linkedCaseId || req.body.linkedcase || null;
        const emailBody = req.body.emailBody || req.body.body || req.body.content || null;

        console.log("Received add-task:", {
            fileName,
            date,
            link,
            linkedCase,
            messageId,
            fileCount: Array.isArray(req.files) ? req.files.length : 0
        });

        if (!fileName) {
            return res.status(400).json({ success: false, message: "fileName (email subject) is required" });
        }

        const uploadedFiles = [];
        const skippedFiles = [];

        if (Array.isArray(req.files) && req.files.length) {
            for (const file of req.files) {
                // Skip very large files (Notion single-part limit is ~20MB)
                if (file.size > 20 * 1024 * 1024) {
                    console.warn(`Skipping large file (>20MB): ${file.originalname}`);
                    skippedFiles.push(file.originalname);
                    continue;
                }

                // Improved MIME type detection
                let contentType = (file.mimetype && file.mimetype !== 'application/octet-stream')
                    ? file.mimetype
                    : (mime.lookup(file.originalname) || 'application/octet-stream');

                if (contentType === 'application/octet-stream') {
                    console.warn(`Skipping file with unknown MIME type: ${file.originalname}`);
                    skippedFiles.push(file.originalname);
                    continue;
                }

                try {
                    console.log(`Uploading: ${file.originalname} | Type: ${contentType} | Size: ${(file.size / 1024).toFixed(1)} KB`);

                    const createUpload = await notion.request({
                        method: "POST",
                        path: "file_uploads",
                        body: {
                            mode: "single_part",
                            filename: file.originalname,
                            content_type: contentType
                        }
                    });

                    const { id: uploadId, upload_url: uploadUrl } = createUpload || {};

                    if (!uploadId || !uploadUrl) {
                        throw new Error("Invalid upload slot response from Notion");
                    }

                    const form = new FormData();
                    form.append('file', file.buffer, {
                        filename: file.originalname,
                        contentType: contentType
                    });

                    const uploadResponse = await axios.post(uploadUrl, form, {
                        headers: form.getHeaders(),   // Only FormData headers - Very Important
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    });

                    if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
                        throw new Error(`Upload failed with status ${uploadResponse.status}`);
                    }

                    // Clean filename for Notion
                    let displayName = file.originalname;
                    if (displayName.length > 100) {
                        const dotIndex = displayName.lastIndexOf('.');
                        if (dotIndex > 0) {
                            const base = displayName.slice(0, dotIndex);
                            const ext = displayName.slice(dotIndex);
                            displayName = base.slice(0, 96 - ext.length) + '...' + ext;
                        } else {
                            displayName = displayName.slice(0, 97) + '...';
                        }
                    }

                    uploadedFiles.push({
                        name: displayName,
                        type: "file_upload",
                        file_upload: { id: uploadId }
                    });

                } catch (uploadErr) {
                    console.error(`Failed to upload ${file.originalname}:`, uploadErr.message || uploadErr);
                    skippedFiles.push(file.originalname);
                }
            }
        }

        // ====================== CREATE THE PAGE ======================
        const properties = {
            "File Name": {
                title: [{ type: "text", text: { content: fileName } }]
            },
            "File": { files: uploadedFiles },
            "File Type": { select: { name: "Email" } },
            "Message ID": { rich_text: messageId ? [{ text: { content: messageId } }] : [] }
        };

        if (date) properties["Date"] = { date: { start: date } };
        if (link) properties["Link"] = { url: link };
        if (linkedCase) {
            properties["Linked Case"] = { relation: [{ id: linkedCase }] };
        }

        const page = await notion.pages.create({
            parent: { database_id: dashboardId },
            properties
        });

        // ====================== Add skipped files warning (if any) ======================
        if (skippedFiles.length > 0) {
            try {
                await notion.blocks.children.append({
                    block_id: page.id,
                    children: [{
                        object: "block",
                        type: "paragraph",
                        paragraph: {
                            rich_text: [{
                                type: "text",
                                text: { 
                                    content: `⚠️ Could not upload the following attachments:\n• ${skippedFiles.join('\n• ')}`
                                }
                            }]
                        }
                    }]
                });
            } catch (appendErr) {
                console.error("Failed to append skipped files warning:", appendErr.message);
                // Don't fail the whole request for this
            }
        }

        // ====================== Append Email Body ======================
        if (emailBody && emailBody.trim().length > 0) {
            const maxLength = 2000;
            const chunks = [];
            let start = 0;

            while (start < emailBody.length) {
                let end = Math.min(start + maxLength, emailBody.length);
                if (end < emailBody.length) {
                    const slice = emailBody.slice(start, end);
                    const lastSpace = slice.lastIndexOf(' ');
                    const lastNewline = slice.lastIndexOf('\n');
                    const breakPoint = Math.max(lastSpace, lastNewline);
                    if (breakPoint > maxLength / 2) {
                        end = start + breakPoint + 1;
                    }
                }
                chunks.push(emailBody.slice(start, end));
                start = end;
            }

            const batchSize = 100;
            for (let i = 0; i < chunks.length; i += batchSize) {
                const batch = chunks.slice(i, i + batchSize);
                const children = batch.map(chunk => ({
                    object: "block",
                    type: "paragraph",
                    paragraph: {
                        rich_text: [{ type: "text", text: { content: chunk } }]
                    }
                }));

                await notion.blocks.children.append({
                    block_id: page.id,
                    children
                });
            }
        }

        console.log("Successfully created Notion page:", page.id);
        res.status(200).json({ success: true, pageId: page.id });

    } catch (error) {
        console.error("Error creating Notion page:", error);
        if (error.body) console.error("Notion error body:", error.body);
        
        res.status(500).json({
            success: false,
            message: error.message || "Unknown error occurred while creating Notion page"
        });
    }
});

app.get('/search-cases', async (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();

        if (!q || q.length < 2) {
            return res.json({ results: [] });
        }

        let allResults = [];
        let has_more = true;
        let start_cursor = undefined;

        while (has_more) {
            const response = await fetch(`https://api.notion.com/v1/databases/${CASE_DB_ID}/query`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                    'Notion-Version': NOTION_VERSION,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    // Looser filter — we will refine on the server
                    filter: {
                        property: "שם תיק",   // Make sure this is the exact property name (Hebrew)
                        title: {
                            contains: q   // Keep this for performance, but we'll filter more below
                        }
                    },
                    page_size: 100,
                    ...(start_cursor && { start_cursor })
                })
            });

            const data = await response.json();

            if (!response.ok) {
                console.error("Notion API error:", data);
                throw new Error(data.message || 'Notion API error');
            }

            const pageResults = data.results.map(page => {
                // Use the correct property name here too
                const titleProp = page.properties['שם תיק'] || page.properties['File Name'];
                const title = titleProp?.title
                    ?.map(t => t.plain_text)
                    ?.join('') || "(untitled)";

                return {
                    id: page.id,
                    title,
                    raw: page.properties
                };
            });

            allResults = allResults.concat(pageResults);
            has_more = data.has_more;
            start_cursor = data.next_cursor;
        }

        // === SMART CLIENT-SIDE FILTERING ===
        const filtered = allResults.filter(item => {
            const titleLower = item.title.toLowerCase();
            return titleLower.includes(q);
        });

        // Optional: sort by how close the match is (better UX)
        // e.g. exact word match first, then substring
        filtered.sort((a, b) => {
            const aTitle = a.title.toLowerCase();
            const bTitle = b.title.toLowerCase();

            const aExact = aTitle.includes(' ' + q + ' ') || aTitle === q || aTitle.startsWith(q + ' ') || aTitle.endsWith(' ' + q);
            const bExact = bTitle.includes(' ' + q + ' ') || bTitle === q || bTitle.startsWith(q + ' ') || bTitle.endsWith(' ' + q);

            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            return 0;
        });

        res.json({ results: filtered });

    } catch (err) {
        console.error("Full error:", err);
        res.status(500).json({
            error: 'search failed',
            details: err.message
        });
    }
});


app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});