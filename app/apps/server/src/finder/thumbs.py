# thumbs.py <tag> <media>: a 32x18 grey picture of every scanned frame, to tell a cut from a continuing shot
import sys,json,os,cv2,numpy as np
from multiprocessing import Pool
sys.argv=[sys.argv[0],sys.argv[1],sys.argv[2]]
import scan
tag,mid=sys.argv[1],sys.argv[2]; STEP=10
def work(ab):
    a,b=ab; cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); fps=cap.get(cv2.CAP_PROP_FPS)
    f0=int(round(a*fps)); f0-=f0%STEP; f1=int(b*fps); cap.set(cv2.CAP_PROP_POS_FRAMES,f0); out=[]; f=f0
    while f<=f1:
        ok,img=cap.read()
        if not ok: break
        out.append((f,cv2.resize(cv2.cvtColor(img,cv2.COLOR_BGR2GRAY),(32,18),interpolation=cv2.INTER_AREA)))
        for _ in range(STEP-1):
            if not cap.grab(): break
        f+=STEP
    return out
if __name__=='__main__':
    fs=[]; th=[]
    with Pool(6) as p:
        for res in p.imap(work,scan.chunks()):
            for f,t in res: fs.append(f); th.append(t)
    np.savez_compressed(f'{tag}/scan/{mid}.thumbs.npz',f=np.array(fs),t=np.array(th))
    print(mid,len(fs))
