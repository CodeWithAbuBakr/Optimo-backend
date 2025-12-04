const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@notionhq/client');
const multer = require("multer");
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
const upload = multer();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(cors({
    credentials: true,
    origin: [
        'https://localhost:3000',
        'http://192.168.1.5:3000',
    ]
}));

const PORT = 5000;
const HOST = 'localhost';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const dashboardId = process.env.NOTION_DASHBOARD_ID;

app.post("/add-task", upload.array("files"), async (req, res) => {
    try {
        const { fileName, date, link, linkedCase, messageId } = req.body;

        const uploadedFiles = [];

        // ---- 1. Upload each file to Notion ----
        for (const file of req.files) {
            // STEP 1: Create Notion file upload
            const createUpload = await notion.request({
                method: "POST",
                path: "file_uploads",
                body: {
                    file_name: file.originalname,
                }
            });

            const uploadId = createUpload.id;

            // STEP 2: Send binary data
            await notion.request({
                method: "POST",
                path: `file_uploads/${uploadId}/send`,
                body: {
                    file: file.buffer
                }
            });

            // Add to property format
            uploadedFiles.push({
                type: "file_upload",
                name: file.originalname,
                file_upload: { id: uploadId }
            });
        }

        // ---- 2. Build properties ----
        const properties = {
            "File Name": {
                title: [{ text: { content: fileName } }]
            },
            "File": {
                files: uploadedFiles
            },
            "File Type": {
                email: "example@domain.com"
            }
        };

        if (date) properties["Date"] = { date: { start: date } };
        if (link) properties["Link"] = { url: link };
        if (linkedCase) properties["Linked Case"] = { url: linkedCase };
        if (messageId)
            properties["Message ID"] = {
                rich_text: [{ text: { content: messageId } }]
            };

        // ---- 3. Create the Notion page ----
        const response = await notion.pages.create({
            parent: { database_id: dashboardId },
            properties
        });

        res.status(200).json({ success: true, pageId: response.id });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});
