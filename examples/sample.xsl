<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:output method="html" indent="yes"/>

    <xsl:template match="/">
        <html>
            <head>
                <title>Book Catalog</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    h1 { color: #333; }
                    .book { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 5px; }
                    .title { font-size: 1.2em; font-weight: bold; color: #0066cc; }
                    .author { color: #666; font-style: italic; }
                    .price { color: #008000; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Book Catalog</h1>
                <xsl:apply-templates select="catalog/book"/>
            </body>
        </html>
    </xsl:template>

    <xsl:template match="book">
        <div class="book">
            <div class="title"><xsl:value-of select="title"/></div>
            <div class="author">by <xsl:value-of select="author"/></div>
            <div>Genre: <xsl:value-of select="genre"/></div>
            <div class="price">Price: $<xsl:value-of select="price"/></div>
            <div>Published: <xsl:value-of select="publish_date"/></div>
            <p><xsl:value-of select="description"/></p>
        </div>
    </xsl:template>

</xsl:stylesheet>
