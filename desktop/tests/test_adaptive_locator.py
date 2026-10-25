import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from desktop.adaptive_locator import locate_controls
from desktop.ocr import OcrBBox, OcrWord, OcrResult


def fixture(width,height,scale=1,duplicates=False,green=True):
    x,y=int(width*.6),int(height*.7)
    bw,bh=round(48*scale),round(22*scale)
    word=OcrWord('发 表',OcrBBox(x,y,bw,bh))
    words=[word,OcrWord('发现',OcrBBox(round(width*.04),round(height*.3),bw,bh)),
        OcrWord('朋友圈',OcrBBox(round(width*.2),round(height*.2),bw,bh))]
    if duplicates: words.append(OcrWord('发表',OcrBBox(x,y-bh*4,bw,bh)))
    rows=[]
    for yy in range(height):
        row=bytearray(bytes((245,245,245))*width)
        if green and y-bh<=yy<y+bh*2:
            row[(x-bh)*3:(x+bw+bh)*3]=bytes((43,197,124))*(bw+bh*2)
        if duplicates and green and y-bh*5<=yy<y-bh*2:
            row[(x-bh)*3:(x+bw+bh)*3]=bytes((43,197,124))*(bw+bh*2)
        rows.append(bytes(row))
    return OcrResult(available=True,words=words),rows,word


class AdaptiveLocatorTest(unittest.TestCase):
    def test_resolution_and_dpi_matrix(self):
        for width,height in ((800,600),(1200,900),(1920,1080),(2560,1440),(3840,2160)):
            for dpi in (1,1.25,1.5,1.75,2):
                with self.subTest(width=width,height=height,dpi=dpi):
                    ocr,rows,word=fixture(width,height,dpi)
                    targets=locate_controls(ocr,width,height,rows)
                    self.assertEqual((targets['publish']['x'],targets['publish']['y']),word.bbox.center)
                    self.assertIn('discover',targets);self.assertIn('moments_entry',targets)

    def test_duplicate_publish_labels_are_rejected(self):
        ocr,rows,_=fixture(1200,900,duplicates=True)
        self.assertNotIn('publish',locate_controls(ocr,1200,900,rows))

    def test_text_without_green_and_body_text_cannot_be_publish_targets(self):
        ocr,rows,_=fixture(1200,900,green=False)
        self.assertNotIn('publish',locate_controls(ocr,1200,900,rows))
        ocr.words=[OcrWord('今天想发表一些想法',OcrBBox(500,600,200,30))]
        self.assertEqual(locate_controls(ocr,1200,900,rows),{})

    def test_invalid_boxes_and_unavailable_ocr_are_rejected(self):
        result=OcrResult(available=True,words=[OcrWord('发现',OcrBBox(-1,20,30,20))])
        self.assertEqual(locate_controls(result,800,600),{})
        result.available=False
        self.assertEqual(locate_controls(result,800,600),{})

    def test_word_and_line_duplicate_is_one_target(self):
        result,rows,word=fixture(1200,900)
        result.lines=[word]
        self.assertIn('publish',locate_controls(result,1200,900,rows))
