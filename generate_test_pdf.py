from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

def create_financial_pdf(filename):
    doc = SimpleDocTemplate(filename, pagesize=letter)
    elements = []
    styles = getSampleStyleSheet()

    elements.append(Paragraph("Project Titan — Financial Performance Overview", styles['Title']))
    elements.append(Paragraph("This document contains the historical financial audit for the acquisition target.", styles['Normal']))
    
    # Financial Table
    data = [
        ["Metric", "FY21", "FY22", "FY23", "FY24 (Proj)"],
        ["Revenue ($M)", "120.5", "145.2", "182.0", "215.5"],
        ["EBITDA ($M)", "18.2", "22.5", "31.8", "38.2"],
        ["Op Expenses ($M)", "85.0", "98.5", "115.0", "132.0"],
        ["Headcount", "450", "485", "520", "560"]
    ]
    
    t = Table(data)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.cadetblue),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
        ('GRID', (0,0), (-1,-1), 1, colors.black)
    ]))
    
    elements.append(t)
    doc.build(elements)

if __name__ == "__main__":
    create_financial_pdf("financial_audit.pdf")
    print("financial_audit.pdf generated successfully.")
