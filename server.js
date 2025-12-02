const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@notionhq/client');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(cors({
    credentials: true,
    origin: [
        'http://localhost:5173',
        'http://192.168.1.5:5173',
        'http://localhost:3000',
        'http://192.168.1.5:3000',
        'http://localhost:3001',
        'http://192.168.1.5:3001',
        'https://tlbr-io-frontend.vercel.app'
    ]
}));

const PORT = 5000;
const HOST = 'localhost';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const dashboardId = process.env.NOTION_DASHBOARD_ID;

app.post('/add-task', async (req, res) => {
    try {
        const {
            fileName,
            fileUrl,
            date,
            link,
            linkedCase,
            messageId
        } = req.body;

        const properties = {};

        // File Name (title)
        if (fileName) {
            properties["File Name"] = {
                title: [{ text: { content: fileName } }]
            };
        }

        // File (optional)
        if (fileUrl && fileName) {
            properties["File"] = {
                files: [
                    {
                        name: fileName,
                        type: "external",
                        external: { url: fileUrl }
                    }
                ]
            };
        }

        // File Type (select, always Email)
        properties["File Type"] = {
            email: "example@domain.com"
        };

        // Date
        if (date) {
            properties["Date"] = {
                date: { start: date }
            };
        }

        // Link (URL)
        if (link) {
            properties["Link"] = { url: link };
        }

        // Linked Case (URL)
        if (linkedCase) {
            properties["Linked Case"] = { url: linkedCase };
        }

        // Message ID
        if (messageId) {
            properties["Message ID"] = {
                rich_text: [{ text: { content: messageId } }]
            };
        }

        const response = await notion.pages.create({
            parent: { database_id: dashboardId },
            properties
        });

        res.status(200).json({ success: true, pageId: response.id });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Failed to create Notion page' });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});
