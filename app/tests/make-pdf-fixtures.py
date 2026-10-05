from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from pypdf import PdfReader, PdfWriter

out = Path(__file__).parent / 'fixtures'
out.mkdir(exist_ok=True)

def panel(c, x, width, title, sub, color, height=210*mm):
    c.setFillColor(HexColor(color))
    c.rect(x, 0, width, height, fill=1, stroke=0)
    c.setFillColor(HexColor('#e9e3d5'))
    c.setFont('Times-Bold', 37)
    c.drawCentredString(x + width/2, height*.68, title)
    c.setFont('Helvetica', 11)
    c.drawCentredString(x + width/2, height*.61, sub)
    c.setStrokeColor(HexColor('#e9e3d5'))
    c.setLineWidth(1)
    c.circle(x + width/2, height*.36, width*.22, stroke=1, fill=0)
    c.setFont('Helvetica', 9)
    c.drawCentredString(x + width/2, height*.1, 'EDIZIONI STUDIO')

c = canvas.Canvas(str(out/'cover-spread.pdf'), pagesize=(308*mm, 210*mm))
panel(c, 0, 150*mm, 'TEMPO', 'RETRO DEL LIBRO', '#354440')
c.setFillColor(HexColor('#26312e')); c.rect(150*mm, 0, 8*mm, 210*mm, fill=1, stroke=0)
c.saveState(); c.translate(154*mm, 105*mm); c.rotate(90)
c.setFillColor(HexColor('#e9e3d5')); c.setFont('Helvetica', 8); c.drawCentredString(0, 0, 'FORMA - EDIZIONI STUDIO'); c.restoreState()
panel(c, 158*mm, 150*mm, 'FORMA', 'IL TEMPO DELLE COSE', '#344f46')
c.showPage(); c.save()

c = canvas.Canvas(str(out/'cover-separate.pdf'), pagesize=(150*mm, 210*mm))
panel(c, 0, 150*mm, 'FORMA', 'IL TEMPO DELLE COSE', '#344f46'); c.showPage()
panel(c, 0, 150*mm, 'TEMPO', 'RETRO DEL LIBRO', '#354440'); c.showPage(); c.save()

for name, pages in [('interior-5-pages.pdf', 5), ('interior-100-pages.pdf', 100)]:
    c = canvas.Canvas(str(out/name), pagesize=(150*mm, 210*mm))
    for i in range(1, pages+1):
        color = ['#e8e2d5', '#d3dfd6', '#e8c7ad', '#cbd8e3', '#d9d0dd'][(i-1)%5]
        c.setFillColor(HexColor(color)); c.rect(0, 0, 150*mm, 210*mm, fill=1, stroke=0)
        c.setFillColor(HexColor('#34463f')); c.setFont('Times-Bold', 58)
        c.drawString(18*mm, 145*mm, f'{i:02}')
        c.setFont('Times-Roman', 24); c.drawString(18*mm, 125*mm, 'Il tempo delle cose')
        c.setFont('Helvetica', 11)
        c.drawString(18*mm, 113*mm, 'Ogni pagina, un nuovo punto di vista.')
        for line in range(15):
            c.setFillColor(HexColor('#7c857b')); c.rect(18*mm, (93-line*4)*mm, (108 if line%4 else 75)*mm, .3*mm, fill=1, stroke=0)
        c.setFont('Helvetica', 10); c.drawCentredString(75*mm, 12*mm, f'PAGINA {i} - '+('RECTO' if i%2 else 'VERSO'))
        c.showPage()
    c.save()

reader = PdfReader(out/'interior-5-pages.pdf')
writer = PdfWriter(); writer.append(reader); writer.encrypt('test-only')
with (out/'protected.pdf').open('wb') as stream: writer.write(stream)
(out/'invalid.pdf').write_text('Not a PDF - test fixture')
